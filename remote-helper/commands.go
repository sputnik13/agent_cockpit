package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// maxReadFileBytes caps the content returned by readFile (2 MiB).
const maxReadFileBytes = 2 << 20

// binarySniffBytes bounds the NUL-byte scan used to classify content as
// binary. Mirrors electron/main/git/files.ts's looksBinary exactly (same
// 8000-byte prefix bound), so local and remote report the same isBinary
// verdict for identical file content.
const binarySniffBytes = 8000

// execTimeout bounds any shelled-out command.
//
// Tools are spawned by bare name (br, git); the helper's process PATH is fixed
// once at startup by bootstrapPath() (see pathboot.go) so these resolve even
// though the ssh exec PATH omits ~/.local/bin / Homebrew.
const execTimeout = 30 * time.Second

// runGit executes git in dir with the given args and returns stdout. On a
// non-zero exit it returns an error including stderr.
func runCommand(dir, name string, args ...string) (string, error) {
	if dir == "" {
		return "", fmt.Errorf("%s: cwd must not be empty", name)
	}
	ctx, cancel := context.WithTimeout(context.Background(), execTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil {
		return stdout.String(), fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}

// --- readFile ---

type readFileParams struct {
	Path string `json:"path"`
	// Ref, when non-empty, reads the file AT a git ref via `git show <ref>:<path>`
	// (e.g. the diff old side or the "raw at baseline" view) instead of the
	// working tree. Path is then repo-relative and Cwd is the repo (or worktree)
	// root the `git show` runs in.
	Ref string `json:"ref,omitempty"`
	Cwd string `json:"cwd,omitempty"`
	// WorktreePath, when non-empty, resolves a relative working-tree Path against
	// that worktree root (falling back to the Path as-given when empty). Absolute
	// paths are honored verbatim, so the project-root default is unchanged.
	WorktreePath string `json:"worktreePath,omitempty"`
}

type readFileResult struct {
	Content   string `json:"content"`
	Truncated bool   `json:"truncated"`
	// IsBinary mirrors electron/main/git/files.ts's looksBinary semantics (a
	// NUL byte within the first binarySniffBytes bytes). Computed from the
	// same bytes already read for Content — no second read, no extra RPC.
	IsBinary bool `json:"isBinary"`
	// SizeBytes is the TRUE byte size of the underlying content (on-disk file
	// size for a working-tree read, full `git show` blob length for a ref
	// read) — independent of any cap/truncation applied to Content, and NOT
	// derived from Content (which, once JSON-encoded, substitutes invalid
	// UTF-8 with U+FFFD and would inflate a binary file's apparent size).
	// Mirrors electron/main/git/files.ts's getFile, whose sizeBytes is always
	// a real stat()/buffer-length value, never computed from the (possibly
	// nulled) content string. Computed from data the handler already has — no
	// second read, no extra RPC.
	SizeBytes int64 `json:"sizeBytes"`
}

func handleReadFile(raw json.RawMessage) (interface{}, error) {
	var p readFileParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("readFile: decode params: %w", err)
	}
	if p.Path == "" {
		return nil, fmt.Errorf("readFile: path must not be empty")
	}
	// Ref read: `git show <ref>:<repo-relative-path>` in the repo root. Same
	// truncation cap as the working-tree path so callers see a uniform contract.
	if p.Ref != "" {
		if p.Cwd == "" {
			return nil, fmt.Errorf("readFile: cwd must not be empty when ref is set")
		}
		out, err := runCommand(p.Cwd, "git", "show", p.Ref+":"+p.Path)
		if err != nil {
			return nil, err
		}
		isBin := looksBinaryString(out)
		// Capture the full blob length BEFORE the truncation slice below — the
		// true size, mirroring local's ref-path sizeBytes (buf.length of the
		// full git-cat-file blob, read before its truncation check).
		sizeBytes := int64(len(out))
		truncated := len(out) > maxReadFileBytes
		if truncated {
			out = out[:maxReadFileBytes]
		}
		return readFileResult{Content: out, Truncated: truncated, IsBinary: isBin, SizeBytes: sizeBytes}, nil
	}
	// Working-tree read: resolve a relative path against the worktree root when
	// supplied; empty/absent falls back to the path as-given (already absolute
	// for the project-root default).
	target := p.Path
	if p.WorktreePath != "" && !filepath.IsAbs(target) {
		target = filepath.Join(p.WorktreePath, target)
	}
	f, err := os.Open(target)
	if err != nil {
		return nil, fmt.Errorf("readFile: open %q: %w", target, err)
	}
	defer f.Close()

	// True on-disk size via a stat on the fd already open for the read below —
	// no extra RPC, and (unlike the byte count from the capped read) still
	// correct when the file is larger than maxReadFileBytes. Falls back to the
	// bytes actually read if the stat somehow fails (the fd was just opened
	// successfully, so this is a defensive, not expected, path).
	var sizeBytes int64
	statOK := false
	if fi, statErr := f.Stat(); statErr == nil {
		sizeBytes = fi.Size()
		statOK = true
	}

	// Read one byte past the cap so we can detect truncation.
	buf := make([]byte, maxReadFileBytes+1)
	n, err := io.ReadFull(f, buf)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return nil, fmt.Errorf("readFile: read %q: %w", target, err)
	}
	isBin := looksBinary(buf[:n])
	truncated := n > maxReadFileBytes
	if truncated {
		n = maxReadFileBytes
	}
	if !statOK {
		sizeBytes = int64(n)
	}
	return readFileResult{Content: string(buf[:n]), Truncated: truncated, IsBinary: isBin, SizeBytes: sizeBytes}, nil
}

// looksBinary reports whether buf's first binarySniffBytes bytes contain a
// NUL byte — the same heuristic electron/main/git/files.ts's looksBinary uses
// on the local read path. A bounded prefix scan, not full MIME sniffing, by
// design (matches local exactly rather than being "more correct").
func looksBinary(buf []byte) bool {
	n := len(buf)
	if n > binarySniffBytes {
		n = binarySniffBytes
	}
	return bytes.IndexByte(buf[:n], 0) >= 0
}

// looksBinaryString is looksBinary for content already captured as a string
// (the git-show ref-read path). It slices the bounded prefix BEFORE
// converting to []byte, so classifying a large ref blob never copies more
// than binarySniffBytes worth of content just to sniff it.
func looksBinaryString(s string) bool {
	n := len(s)
	if n > binarySniffBytes {
		n = binarySniffBytes
	}
	return looksBinary([]byte(s[:n]))
}

// readCappedFile reads up to maxReadFileBytes of a working-tree file, reporting
// truncation. Shared by getDiffBundle.
func readCappedFile(path string) (string, bool, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", false, err
	}
	defer f.Close()
	buf := make([]byte, maxReadFileBytes+1)
	n, err := io.ReadFull(f, buf)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return "", false, err
	}
	if n > maxReadFileBytes {
		return string(buf[:maxReadFileBytes]), true, nil
	}
	return string(buf[:n]), false, nil
}

// gitShowCapped returns `git show <ref>:<path>` content (cwd = repo root), capped.
func gitShowCapped(cwd, ref, path string) (string, bool, error) {
	out, err := runCommand(cwd, "git", "show", ref+":"+path)
	if err != nil {
		return "", false, err
	}
	if len(out) > maxReadFileBytes {
		return out[:maxReadFileBytes], true, nil
	}
	return out, false, nil
}

// --- getDiffBundle ---

type getDiffBundleParams struct {
	Cwd      string `json:"cwd"`
	Path     string `json:"path"`
	Baseline string `json:"baseline,omitempty"`
}

// getDiffBundleResult carries everything the Content view needs to render and
// highlight a diff in ONE round trip: the unified patch plus both sides' content.
// The *Readable flags distinguish "empty file" from "absent/unreadable" (an
// added file has no old side; a deleted file has no new side) without erroring.
type getDiffBundleResult struct {
	Patch        string `json:"patch"`
	NewContent   string `json:"newContent"`
	NewReadable  bool   `json:"newReadable"`
	NewTruncated bool   `json:"newTruncated"`
	OldContent   string `json:"oldContent"`
	OldReadable  bool   `json:"oldReadable"`
	OldTruncated bool   `json:"oldTruncated"`
}

func handleGetDiffBundle(raw json.RawMessage) (interface{}, error) {
	var p getDiffBundleParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("getDiffBundle: decode params: %w", err)
	}
	if p.Cwd == "" {
		return nil, fmt.Errorf("getDiffBundle: cwd must not be empty")
	}
	if p.Path == "" {
		return nil, fmt.Errorf("getDiffBundle: path must not be empty")
	}
	args := []string{"diff"}
	if p.Baseline != "" {
		args = append(args, p.Baseline)
	}
	args = append(args, "--", p.Path)
	patch, err := runCommand(p.Cwd, "git", args...)
	if err != nil {
		return nil, err
	}
	res := getDiffBundleResult{Patch: patch}
	// New side: working-tree file. Tolerant — a deleted file is simply unreadable.
	if content, truncated, rerr := readCappedFile(filepath.Join(p.Cwd, p.Path)); rerr == nil {
		res.NewContent, res.NewTruncated, res.NewReadable = content, truncated, true
	}
	// Old side: content at the baseline ref. Tolerant — an added file has none.
	if p.Baseline != "" {
		if content, truncated, gerr := gitShowCapped(p.Cwd, p.Baseline, p.Path); gerr == nil {
			res.OldContent, res.OldTruncated, res.OldReadable = content, truncated, true
		}
	}
	return res, nil
}

// --- stat ---

type statParams struct {
	Path string `json:"path"`
}

type statResult struct {
	Exists bool   `json:"exists"`
	Size   int64  `json:"size"`
	IsDir  bool   `json:"isDir"`
	Mtime  string `json:"mtime"`
}

func handleStat(raw json.RawMessage) (interface{}, error) {
	var p statParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("stat: decode params: %w", err)
	}
	if p.Path == "" {
		return nil, fmt.Errorf("stat: path must not be empty")
	}
	info, err := os.Stat(p.Path)
	if err != nil {
		if os.IsNotExist(err) {
			return statResult{Exists: false}, nil
		}
		return nil, fmt.Errorf("stat: %q: %w", p.Path, err)
	}
	return statResult{
		Exists: true,
		Size:   info.Size(),
		IsDir:  info.IsDir(),
		Mtime:  info.ModTime().UTC().Format(time.RFC3339Nano),
	}, nil
}

// --- gitStatus ---

type gitStatusParams struct {
	Cwd      string `json:"cwd"`
	Baseline string `json:"baseline,omitempty"`
}

type statusEntry struct {
	Path   string `json:"path"`
	Status string `json:"status"`
}

func handleGitStatus(raw json.RawMessage) (interface{}, error) {
	var p gitStatusParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("gitStatus: decode params: %w", err)
	}
	if p.Cwd == "" {
		return nil, fmt.Errorf("gitStatus: cwd must not be empty")
	}

	entries := []statusEntry{}

	// Working-tree status via porcelain v1 (-z null-delimited records).
	// --untracked-files=all expands untracked directories into individual files
	// (the default collapses a non-empty untracked dir to one entry); .gitignore
	// is still honored.
	out, err := runCommand(p.Cwd, "git", "status", "--porcelain", "-z", "--untracked-files=all")
	if err != nil {
		return nil, err
	}
	for _, rec := range splitNUL(out) {
		if len(rec) < 4 {
			continue
		}
		code := strings.TrimSpace(rec[:2])
		path := rec[3:]
		entries = append(entries, statusEntry{Path: path, Status: code})
	}

	// If a baseline ref is supplied, also include the diff against it so the
	// client can show changes relative to a fork point.
	if p.Baseline != "" {
		diffOut, err := runCommand(p.Cwd, "git", "diff", "--name-status", "-z", p.Baseline)
		if err != nil {
			return nil, err
		}
		fields := splitNUL(diffOut)
		for i := 0; i+1 < len(fields); i += 2 {
			code := strings.TrimSpace(fields[i])
			path := fields[i+1]
			// Renames carry an extra path field; skip the old name.
			if strings.HasPrefix(code, "R") || strings.HasPrefix(code, "C") {
				if i+2 < len(fields) {
					path = fields[i+2]
					i++
				}
			}
			if !containsPath(entries, path) {
				entries = append(entries, statusEntry{Path: path, Status: code})
			}
		}
	}

	return entries, nil
}

func containsPath(entries []statusEntry, path string) bool {
	for _, e := range entries {
		if e.Path == path {
			return true
		}
	}
	return false
}

// --- gitDiff ---

type gitDiffParams struct {
	Cwd      string `json:"cwd"`
	Path     string `json:"path"`
	Baseline string `json:"baseline,omitempty"`
}

type gitDiffResult struct {
	Patch string `json:"patch"`
}

func handleGitDiff(raw json.RawMessage) (interface{}, error) {
	var p gitDiffParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("gitDiff: decode params: %w", err)
	}
	if p.Cwd == "" {
		return nil, fmt.Errorf("gitDiff: cwd must not be empty")
	}
	if p.Path == "" {
		return nil, fmt.Errorf("gitDiff: path must not be empty")
	}

	args := []string{"diff"}
	if p.Baseline != "" {
		args = append(args, p.Baseline)
	}
	args = append(args, "--", p.Path)
	patch, err := runCommand(p.Cwd, "git", args...)
	if err != nil {
		return nil, err
	}
	return gitDiffResult{Patch: patch}, nil
}

// --- listWorktrees ---

type listWorktreesParams struct {
	Cwd string `json:"cwd"`
}

type worktreeEntry struct {
	Path   string `json:"path"`
	Branch string `json:"branch"`
	Head   string `json:"head"`
}

func handleListWorktrees(raw json.RawMessage) (interface{}, error) {
	var p listWorktreesParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("listWorktrees: decode params: %w", err)
	}
	if p.Cwd == "" {
		return nil, fmt.Errorf("listWorktrees: cwd must not be empty")
	}
	out, err := runCommand(p.Cwd, "git", "worktree", "list", "--porcelain")
	if err != nil {
		return nil, err
	}

	entries := []worktreeEntry{}
	var cur worktreeEntry
	flush := func() {
		if cur.Path != "" {
			entries = append(entries, cur)
		}
		cur = worktreeEntry{}
	}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		switch {
		case strings.HasPrefix(line, "worktree "):
			flush()
			cur.Path = strings.TrimPrefix(line, "worktree ")
		case strings.HasPrefix(line, "HEAD "):
			cur.Head = strings.TrimPrefix(line, "HEAD ")
		case strings.HasPrefix(line, "branch "):
			cur.Branch = strings.TrimPrefix(strings.TrimPrefix(line, "branch "), "refs/heads/")
		case line == "detached":
			cur.Branch = "(detached)"
		}
	}
	flush()
	return entries, nil
}

// --- beadsExec ---
//
// Runs `br <args>` in a project dir and returns its stdout + exit code. This is
// the single seam for BOTH beads reads and writes over the wire — the renderer's
// provider passes argv only (no shell), so issue ids / titles / messages cannot
// inject. (Formerly `beadsQuery`; renamed once writes started flowing through it.)

type beadsExecParams struct {
	Cwd  string   `json:"cwd"`
	Args []string `json:"args"`
}

type beadsExecResult struct {
	Stdout   string `json:"stdout"`
	ExitCode int    `json:"exitCode"`
}

func handleBeadsExec(raw json.RawMessage) (interface{}, error) {
	var p beadsExecParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("beadsExec: decode params: %w", err)
	}
	if p.Cwd == "" {
		return nil, fmt.Errorf("beadsExec: cwd must not be empty")
	}

	ctx, cancel := context.WithTimeout(context.Background(), execTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "br", p.Args...)
	cmd.Dir = p.Cwd
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	exitCode := 0
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			exitCode = exitErr.ExitCode()
		} else {
			return nil, fmt.Errorf("beadsExec: br %s: %w: %s", strings.Join(p.Args, " "), err, strings.TrimSpace(stderr.String()))
		}
	}
	return beadsExecResult{Stdout: stdout.String(), ExitCode: exitCode}, nil
}

// --- listDir ---

type listDirParams struct {
	// Dir is the absolute path to the directory to list.
	Dir string `json:"dir"`
	// Root is the project root, used to compute root-relative paths in the
	// result (matching the shape local.listDir returns to the renderer).
	Root string `json:"root"`
	// WorktreePath, when non-empty, resolves a relative Dir against that worktree
	// root (falling back to Dir as-given when empty). Absolute dirs are honored
	// verbatim, so the project-root default is unchanged.
	WorktreePath string `json:"worktreePath,omitempty"`
}

// dirEntry matches the DirEntry shape the renderer expects:
//
//	{ name, path, isDir }
//
// where path is relative to the project root.
type dirEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	IsDir bool   `json:"isDir"`
}

func handleListDir(raw json.RawMessage) (interface{}, error) {
	var p listDirParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("listDir: decode params: %w", err)
	}
	if p.Dir == "" {
		return nil, fmt.Errorf("listDir: dir must not be empty")
	}
	// Resolve a relative Dir against the worktree root when supplied; empty/absent
	// falls back to Dir as-given (already absolute for the project-root default).
	dir := p.Dir
	if p.WorktreePath != "" && !filepath.IsAbs(dir) {
		dir = filepath.Join(p.WorktreePath, dir)
	}
	if p.Root == "" {
		// Default root to dir so relative paths still work when root is omitted.
		p.Root = dir
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("listDir: read %q: %w", dir, err)
	}

	result := make([]dirEntry, 0, len(entries))
	for _, e := range entries {
		absPath := filepath.Join(dir, e.Name())
		rel, err := filepath.Rel(p.Root, absPath)
		if err != nil {
			rel = e.Name()
		}
		// Use forward slashes for cross-platform consistency (renderer uses POSIX paths).
		rel = filepath.ToSlash(rel)
		result = append(result, dirEntry{
			Name:  e.Name(),
			Path:  rel,
			IsDir: e.IsDir(),
		})
	}

	// Sort: directories first, then alphabetical within each group.
	sort.Slice(result, func(i, j int) bool {
		if result[i].IsDir != result[j].IsDir {
			return result[i].IsDir
		}
		return result[i].Name < result[j].Name
	})

	return result, nil
}

// --- gitBranchPoint ---
//
// Resolves the branch-point (parent branch ref + merge-base SHA) for a
// worktree, mirroring the TypeScript branchPoint.ts parent-resolution rule:
//  1. upstream: git rev-parse --abbrev-ref @{upstream}
//  2. default:  git symbolic-ref refs/remotes/origin/HEAD → "origin/<branch>",
//               else try origin/main, origin/master, main, master in order.
//
// Returns an empty parentRef ("") as the null sentinel when no parent can be
// resolved or the merge-base fails (orphan branch, unrelated histories).

type gitBranchPointParams struct {
	Cwd string `json:"cwd"`
}

type gitBranchPointResult struct {
	ParentRef  string `json:"parentRef"`
	ParentKind string `json:"parentKind"` // "upstream" | "default"
	MergeBase  string `json:"mergeBase"`
}

func handleGitBranchPoint(raw json.RawMessage) (interface{}, error) {
	var p gitBranchPointParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("gitBranchPoint: decode params: %w", err)
	}
	if p.Cwd == "" {
		return nil, fmt.Errorf("gitBranchPoint: cwd must not be empty")
	}

	// null sentinel: an empty parentRef tells the TypeScript caller to return null.
	null := gitBranchPointResult{}

	// 1. Try upstream (@{upstream}).
	parentRef := ""
	parentKind := "upstream"
	if out, err := runCommand(p.Cwd, "git", "rev-parse", "--abbrev-ref", "@{upstream}"); err == nil {
		parentRef = strings.TrimSpace(out)
	}

	// 2. Fallback: resolve the repo default branch.
	if parentRef == "" {
		parentKind = "default"
		// Try origin/HEAD symbolic ref.
		if out, err := runCommand(p.Cwd, "git", "symbolic-ref", "refs/remotes/origin/HEAD"); err == nil {
			sym := strings.TrimSpace(out)
			const prefix = "refs/remotes/"
			if strings.HasPrefix(sym, prefix) {
				parentRef = sym[len(prefix):]
			} else if sym != "" {
				parentRef = sym
			}
		}
		// Well-known remote fallback names (remote-tracking refs only; we do not
		// use bare "main"/"master" because those would match local branches in a
		// repo with no remotes, producing a self-referential merge-base that
		// always equals HEAD).
		if parentRef == "" {
			for _, candidate := range []string{"origin/main", "origin/master"} {
				if _, err := runCommand(p.Cwd, "git", "rev-parse", candidate); err == nil {
					parentRef = candidate
					break
				}
			}
		}
	}

	if parentRef == "" {
		return null, nil
	}

	// Compute merge-base between HEAD and parentRef.
	mbOut, err := runCommand(p.Cwd, "git", "merge-base", "HEAD", parentRef)
	if err != nil {
		// Orphan or unrelated histories → null.
		return null, nil
	}
	mergeBase := strings.TrimSpace(mbOut)
	if mergeBase == "" {
		return null, nil
	}

	return gitBranchPointResult{
		ParentRef:  parentRef,
		ParentKind: parentKind,
		MergeBase:  mergeBase,
	}, nil
}

// splitNUL splits a NUL-delimited string into records, dropping a trailing
// empty field produced by a terminating NUL.
func splitNUL(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, "\x00")
	if len(parts) > 0 && parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	return parts
}
