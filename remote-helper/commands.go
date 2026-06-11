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

// execTimeout bounds any shelled-out command.
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
}

type readFileResult struct {
	Content   string `json:"content"`
	Truncated bool   `json:"truncated"`
}

func handleReadFile(raw json.RawMessage) (interface{}, error) {
	var p readFileParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("readFile: decode params: %w", err)
	}
	if p.Path == "" {
		return nil, fmt.Errorf("readFile: path must not be empty")
	}
	f, err := os.Open(p.Path)
	if err != nil {
		return nil, fmt.Errorf("readFile: open %q: %w", p.Path, err)
	}
	defer f.Close()

	// Read one byte past the cap so we can detect truncation.
	buf := make([]byte, maxReadFileBytes+1)
	n, err := io.ReadFull(f, buf)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return nil, fmt.Errorf("readFile: read %q: %w", p.Path, err)
	}
	truncated := n > maxReadFileBytes
	if truncated {
		n = maxReadFileBytes
	}
	return readFileResult{Content: string(buf[:n]), Truncated: truncated}, nil
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
	if p.Root == "" {
		// Default root to dir so relative paths still work when root is omitted.
		p.Root = p.Dir
	}

	entries, err := os.ReadDir(p.Dir)
	if err != nil {
		return nil, fmt.Errorf("listDir: read %q: %w", p.Dir, err)
	}

	result := make([]dirEntry, 0, len(entries))
	for _, e := range entries {
		absPath := filepath.Join(p.Dir, e.Name())
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
