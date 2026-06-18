package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// initRepo creates a temp git repo with one committed file and returns its path.
func initRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}
	dir := t.TempDir()
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=test", "GIT_AUTHOR_EMAIL=test@example.com",
			"GIT_COMMITTER_NAME=test", "GIT_COMMITTER_EMAIL=test@example.com",
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
	}
	run("init", "-b", "main")
	if err := os.WriteFile(filepath.Join(dir, "tracked.txt"), []byte("hello\n"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}
	run("add", "tracked.txt")
	run("commit", "-m", "initial")
	return dir
}

func TestReadFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "data.txt")
	if err := os.WriteFile(path, []byte("content-here"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := handleReadFile(json.RawMessage(`{"path":` + jstr(path) + `}`))
	if err != nil {
		t.Fatalf("readFile: %v", err)
	}
	r := res.(readFileResult)
	if r.Content != "content-here" {
		t.Fatalf("content = %q", r.Content)
	}
	if r.Truncated {
		t.Fatalf("unexpected truncation")
	}
}

func TestReadFileTruncation(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "big.bin")
	big := make([]byte, maxReadFileBytes+100)
	for i := range big {
		big[i] = 'a'
	}
	if err := os.WriteFile(path, big, 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := handleReadFile(json.RawMessage(`{"path":` + jstr(path) + `}`))
	if err != nil {
		t.Fatalf("readFile: %v", err)
	}
	r := res.(readFileResult)
	if !r.Truncated {
		t.Fatalf("expected truncated=true")
	}
	if len(r.Content) != maxReadFileBytes {
		t.Fatalf("content len = %d want %d", len(r.Content), maxReadFileBytes)
	}
}

func TestReadFileEmptyPath(t *testing.T) {
	if _, err := handleReadFile(json.RawMessage(`{"path":""}`)); err == nil {
		t.Fatal("expected error for empty path")
	}
}

func TestStat(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "f.txt")
	if err := os.WriteFile(path, []byte("12345"), 0o644); err != nil {
		t.Fatal(err)
	}

	res, err := handleStat(json.RawMessage(`{"path":` + jstr(path) + `}`))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	r := res.(statResult)
	if !r.Exists || r.IsDir || r.Size != 5 {
		t.Fatalf("unexpected stat: %+v", r)
	}
	if r.Mtime == "" {
		t.Fatalf("expected mtime")
	}

	// Directory.
	dres, _ := handleStat(json.RawMessage(`{"path":` + jstr(dir) + `}`))
	if !dres.(statResult).IsDir {
		t.Fatalf("expected isDir for %s", dir)
	}

	// Missing.
	mres, err := handleStat(json.RawMessage(`{"path":` + jstr(filepath.Join(dir, "nope")) + `}`))
	if err != nil {
		t.Fatalf("stat missing: %v", err)
	}
	if mres.(statResult).Exists {
		t.Fatalf("expected exists=false")
	}
}

func TestGitStatus(t *testing.T) {
	dir := initRepo(t)
	// Modify tracked, add untracked.
	if err := os.WriteFile(filepath.Join(dir, "tracked.txt"), []byte("changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "new.txt"), []byte("new\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	res, err := handleGitStatus(json.RawMessage(`{"cwd":` + jstr(dir) + `}`))
	if err != nil {
		t.Fatalf("gitStatus: %v", err)
	}
	entries := res.([]statusEntry)
	byPath := map[string]string{}
	for _, e := range entries {
		byPath[e.Path] = e.Status
	}
	if _, ok := byPath["tracked.txt"]; !ok {
		t.Fatalf("expected tracked.txt in status, got %+v", entries)
	}
	if _, ok := byPath["new.txt"]; !ok {
		t.Fatalf("expected new.txt in status, got %+v", entries)
	}
}

// An untracked directory with content must be expanded to its individual files
// (not collapsed to a single "notes/" entry), while .gitignore is still honored.
func TestGitStatusUntrackedDir(t *testing.T) {
	dir := initRepo(t)
	if err := os.WriteFile(filepath.Join(dir, ".gitignore"), []byte("*.log\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "notes"), 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{"a.md": "a\n", "b.md": "b\n", "debug.log": "ignored\n"} {
		if err := os.WriteFile(filepath.Join(dir, "notes", name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	res, err := handleGitStatus(json.RawMessage(`{"cwd":` + jstr(dir) + `}`))
	if err != nil {
		t.Fatalf("gitStatus: %v", err)
	}
	paths := map[string]bool{}
	for _, e := range res.([]statusEntry) {
		paths[e.Path] = true
	}
	if !paths["notes/a.md"] || !paths["notes/b.md"] {
		t.Fatalf("expected individual untracked files under notes/, got %v", paths)
	}
	if paths["notes/"] {
		t.Fatalf("untracked directory should be expanded, not listed as notes/: %v", paths)
	}
	if paths["notes/debug.log"] {
		t.Fatalf("gitignored file should be excluded, got %v", paths)
	}
}

func TestGitDiff(t *testing.T) {
	dir := initRepo(t)
	if err := os.WriteFile(filepath.Join(dir, "tracked.txt"), []byte("hello\nworld\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := handleGitDiff(json.RawMessage(`{"cwd":` + jstr(dir) + `,"path":"tracked.txt"}`))
	if err != nil {
		t.Fatalf("gitDiff: %v", err)
	}
	patch := res.(gitDiffResult).Patch
	if !strings.Contains(patch, "+world") {
		t.Fatalf("expected added line in patch, got:\n%s", patch)
	}
}

func TestListWorktrees(t *testing.T) {
	dir := initRepo(t)
	res, err := handleListWorktrees(json.RawMessage(`{"cwd":` + jstr(dir) + `}`))
	if err != nil {
		t.Fatalf("listWorktrees: %v", err)
	}
	wts := res.([]worktreeEntry)
	if len(wts) != 1 {
		t.Fatalf("expected 1 worktree, got %d: %+v", len(wts), wts)
	}
	if wts[0].Branch != "main" {
		t.Fatalf("expected branch main, got %q", wts[0].Branch)
	}
	if wts[0].Head == "" {
		t.Fatalf("expected non-empty head")
	}
}

func TestGitStatusEmptyCwd(t *testing.T) {
	if _, err := handleGitStatus(json.RawMessage(`{"cwd":""}`)); err == nil {
		t.Fatal("expected error for empty cwd")
	}
}

func TestBeadsExec(t *testing.T) {
	if _, err := exec.LookPath("br"); err != nil {
		t.Skip("br not on PATH")
	}
	dir := t.TempDir()
	res, err := handleBeadsExec(json.RawMessage(`{"cwd":` + jstr(dir) + `,"args":["--version"]}`))
	if err != nil {
		t.Fatalf("beadsExec: %v", err)
	}
	r := res.(beadsExecResult)
	// --version should succeed regardless of repo state.
	if r.ExitCode != 0 {
		t.Logf("br --version exit=%d stdout=%q", r.ExitCode, r.Stdout)
	}
}

// jstr JSON-encodes a string for embedding in a params literal.
func jstr(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func TestListDir(t *testing.T) {
	dir := t.TempDir()
	// Create a mix of files and a sub-directory.
	if err := os.WriteFile(filepath.Join(dir, "b.txt"), []byte("b"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "subdir"), 0o755); err != nil {
		t.Fatal(err)
	}

	params := `{"dir":` + jstr(dir) + `,"root":` + jstr(dir) + `}`
	raw, err := handleListDir(json.RawMessage(params))
	if err != nil {
		t.Fatalf("listDir: %v", err)
	}
	entries := raw.([]dirEntry)

	// Directories must come first.
	if len(entries) != 3 {
		t.Fatalf("expected 3 entries, got %d: %+v", len(entries), entries)
	}
	if !entries[0].IsDir || entries[0].Name != "subdir" {
		t.Fatalf("expected first entry to be subdir, got %+v", entries[0])
	}
	// Files sorted alphabetically after dirs.
	if entries[1].Name != "a.txt" || entries[2].Name != "b.txt" {
		t.Fatalf("expected a.txt, b.txt order, got %+v %+v", entries[1], entries[2])
	}
	// Path must be root-relative with forward slashes.
	if entries[0].Path != "subdir" {
		t.Fatalf("expected path=subdir, got %q", entries[0].Path)
	}
	if entries[1].Path != "a.txt" {
		t.Fatalf("expected path=a.txt, got %q", entries[1].Path)
	}
}

func TestListDirErrors(t *testing.T) {
	// Empty dir param.
	if _, err := handleListDir(json.RawMessage(`{"dir":"","root":"/tmp"}`)); err == nil {
		t.Fatal("expected error for empty dir")
	}
	// Non-existent dir.
	if _, err := handleListDir(json.RawMessage(`{"dir":"/nonexistent/path/xyz","root":"/nonexistent/path"}`)); err == nil {
		t.Fatal("expected error for non-existent dir")
	}
}

// --- gitBranchPoint tests ---

// initRepoWithUpstream creates a temp repo with a simulated upstream so that
// @{upstream} resolves. It initialises a "bare" clone (via --separate-git-dir
// tricks would be complex), so we simulate with a local branch and a separate
// origin clone approach using a local path.
func initRepoWithBranch(t *testing.T) (repoDir string, run func(dir string, args ...string)) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}
	run = func(dir string, args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=test", "GIT_AUTHOR_EMAIL=test@example.com",
			"GIT_COMMITTER_NAME=test", "GIT_COMMITTER_EMAIL=test@example.com",
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Logf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
	}
	dir := t.TempDir()
	run(dir, "init", "-b", "main")
	if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte("hello\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	run(dir, "add", "f.txt")
	run(dir, "commit", "-m", "initial")
	return dir, run
}

func TestGitBranchPointEmptyCwd(t *testing.T) {
	if _, err := handleGitBranchPoint(json.RawMessage(`{"cwd":""}`)); err == nil {
		t.Fatal("expected error for empty cwd")
	}
}

func TestGitBranchPointNoUpstreamNoDefault(t *testing.T) {
	// A fresh repo with no remote and no upstream: should return the null sentinel.
	dir, _ := initRepoWithBranch(t)
	res, err := handleGitBranchPoint(json.RawMessage(`{"cwd":` + jstr(dir) + `}`))
	if err != nil {
		t.Fatalf("gitBranchPoint: %v", err)
	}
	r := res.(gitBranchPointResult)
	if r.ParentRef != "" {
		t.Fatalf("expected null sentinel (empty parentRef), got %+v", r)
	}
}

func TestGitBranchPointDefaultBranchFallback(t *testing.T) {
	// Create an "origin" bare-ish local repo and clone it so origin/main is set.
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}
	originDir := t.TempDir()
	cloneDir := t.TempDir()
	gitEnv := []string{
		"GIT_AUTHOR_NAME=test", "GIT_AUTHOR_EMAIL=test@example.com",
		"GIT_COMMITTER_NAME=test", "GIT_COMMITTER_EMAIL=test@example.com",
	}
	runIn := func(dir string, args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), gitEnv...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %s in %s: %v\n%s", strings.Join(args, " "), dir, err, out)
		}
	}

	// Initialise origin with a commit on main.
	runIn(originDir, "init", "-b", "main")
	if err := os.WriteFile(filepath.Join(originDir, "f.txt"), []byte("hello\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	runIn(originDir, "add", "f.txt")
	runIn(originDir, "commit", "-m", "initial")

	// Clone into cloneDir; this sets origin/HEAD → origin/main.
	runIn(cloneDir, "clone", originDir, ".")
	// Create a new feature branch so HEAD is NOT origin/main (no upstream set).
	runIn(cloneDir, "checkout", "-b", "feature")
	if err := os.WriteFile(filepath.Join(cloneDir, "new.txt"), []byte("new\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	runIn(cloneDir, "add", "new.txt")
	runIn(cloneDir, "commit", "-m", "feature commit")

	res, err := handleGitBranchPoint(json.RawMessage(`{"cwd":` + jstr(cloneDir) + `}`))
	if err != nil {
		t.Fatalf("gitBranchPoint: %v", err)
	}
	r := res.(gitBranchPointResult)
	if r.ParentRef == "" {
		t.Fatalf("expected non-empty parentRef for repo with origin/main, got null sentinel")
	}
	if r.ParentKind != "default" {
		t.Fatalf("expected parentKind=default, got %q", r.ParentKind)
	}
	if r.MergeBase == "" {
		t.Fatalf("expected non-empty mergeBase")
	}
}

func TestGitBranchPointUpstream(t *testing.T) {
	// Clone a local origin and set the upstream for the feature branch explicitly.
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}
	originDir := t.TempDir()
	cloneDir := t.TempDir()
	gitEnv := []string{
		"GIT_AUTHOR_NAME=test", "GIT_AUTHOR_EMAIL=test@example.com",
		"GIT_COMMITTER_NAME=test", "GIT_COMMITTER_EMAIL=test@example.com",
	}
	runIn := func(dir string, args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), gitEnv...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %s in %s: %v\n%s", strings.Join(args, " "), dir, err, out)
		}
	}

	runIn(originDir, "init", "-b", "main")
	if err := os.WriteFile(filepath.Join(originDir, "f.txt"), []byte("hello\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	runIn(originDir, "add", "f.txt")
	runIn(originDir, "commit", "-m", "initial")
	runIn(cloneDir, "clone", originDir, ".")
	// Create a feature branch that tracks origin/main explicitly.
	runIn(cloneDir, "checkout", "-b", "feature", "--track", "origin/main")
	if err := os.WriteFile(filepath.Join(cloneDir, "new.txt"), []byte("new\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	runIn(cloneDir, "add", "new.txt")
	runIn(cloneDir, "commit", "-m", "feature commit")

	res, err := handleGitBranchPoint(json.RawMessage(`{"cwd":` + jstr(cloneDir) + `}`))
	if err != nil {
		t.Fatalf("gitBranchPoint: %v", err)
	}
	r := res.(gitBranchPointResult)
	if r.ParentRef == "" {
		t.Fatalf("expected non-empty parentRef, got null sentinel")
	}
	if r.ParentKind != "upstream" {
		t.Fatalf("expected parentKind=upstream, got %q", r.ParentKind)
	}
	if r.MergeBase == "" {
		t.Fatalf("expected non-empty mergeBase")
	}
}

