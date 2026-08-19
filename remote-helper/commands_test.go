package main

import (
	"bytes"
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
	if r.SizeBytes != int64(len("content-here")) {
		t.Fatalf("sizeBytes = %d, want %d", r.SizeBytes, len("content-here"))
	}
}

// Over the default cap: refuse-never-truncate (local_repo_explorer-ftbq) —
// Content is EMPTY (never a truncated prefix), Truncated is true, and
// SizeBytes is the TRUE on-disk size. Mirrors electron/main/git/files.ts's
// getFile working-tree branch exactly. Renamed from the pre-fix
// TestReadFileTruncation, which pinned the OLD (truncate-not-refuse)
// contract this leaf replaces.
func TestReadFileOverCapRefusesWithoutTruncating(t *testing.T) {
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
	if r.Content != "" {
		t.Fatalf("expected EMPTY content (refuse, never a truncated prefix), got len=%d", len(r.Content))
	}
	// SizeBytes must be the TRUE on-disk size (maxReadFileBytes+100) —
	// a stat-derived value, computed WITHOUT reading the file at all.
	if want := int64(len(big)); r.SizeBytes != want {
		t.Fatalf("sizeBytes = %d, want %d (true file size)", r.SizeBytes, want)
	}
}

// An absent/zero maxBytes falls back to the original 2 MiB default cap —
// same fixture/assertions as TestReadFileOverCapRefusesWithoutTruncating,
// just spelled out explicitly against a request that OMITS maxBytes.
func TestReadFileNoMaxBytesFallsBackToDefaultCap(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "big.bin")
	big := make([]byte, maxReadFileBytes+1)
	if err := os.WriteFile(path, big, 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := handleReadFile(json.RawMessage(`{"path":` + jstr(path) + `,"maxBytes":0}`))
	if err != nil {
		t.Fatalf("readFile: %v", err)
	}
	r := res.(readFileResult)
	if !r.Truncated {
		t.Fatalf("expected truncated=true under the default 2 MiB cap (maxBytes=0 must NOT be honored as a real override)")
	}
}

// A file over the DEFAULT cap but under a caller-supplied maxBytes override
// reads FULLY — the structural-fold size-degrade read-cap override
// (local_repo_explorer-ftbq) this leaf exists to make reachable.
func TestReadFileMaxBytesOverrideReadsFully(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "raised.json")
	size := maxReadFileBytes + (1 << 20) // 3 MiB — over the 2 MiB default
	big := make([]byte, size)
	for i := range big {
		big[i] = 'a'
	}
	if err := os.WriteFile(path, big, 0o644); err != nil {
		t.Fatal(err)
	}
	// 4 MiB override — comfortably above `size`, well under maxReadFileCapBytes.
	res, err := handleReadFile(json.RawMessage(`{"path":` + jstr(path) + `,"maxBytes":4194304}`))
	if err != nil {
		t.Fatalf("readFile: %v", err)
	}
	r := res.(readFileResult)
	if r.Truncated {
		t.Fatalf("expected truncated=false: content should read fully under the raised cap")
	}
	if len(r.Content) != size {
		t.Fatalf("content len = %d, want %d (full content, not capped at the default)", len(r.Content), size)
	}
	if r.SizeBytes != int64(size) {
		t.Fatalf("sizeBytes = %d, want %d", r.SizeBytes, size)
	}
}

// A requested maxBytes ABOVE maxReadFileCapBytes (12 MiB) is clamped down to
// it rather than honored verbatim — a file between the clamp ceiling and the
// (larger) requested value must still refuse.
func TestReadFileMaxBytesClampedToHelperCeiling(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping large-fixture test in -short mode")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "beyond-ceiling.json")
	size := maxReadFileCapBytes + (1 << 20) // 13 MiB — over the 12 MiB ceiling
	big := make([]byte, size)
	for i := range big {
		big[i] = 'a'
	}
	if err := os.WriteFile(path, big, 0o644); err != nil {
		t.Fatal(err)
	}
	// Request 50 MiB — far above maxReadFileCapBytes; must clamp to 12 MiB, not
	// be honored verbatim, so this 13 MiB file still refuses.
	res, err := handleReadFile(json.RawMessage(`{"path":` + jstr(path) + `,"maxBytes":52428800}`))
	if err != nil {
		t.Fatalf("readFile: %v", err)
	}
	r := res.(readFileResult)
	if !r.Truncated {
		t.Fatalf("expected truncated=true: a requested maxBytes above the helper ceiling must be clamped, not honored verbatim")
	}
	if r.Content != "" {
		t.Fatalf("expected empty content on refuse, got len=%d", len(r.Content))
	}
	if r.SizeBytes != int64(size) {
		t.Fatalf("sizeBytes = %d, want %d", r.SizeBytes, size)
	}
}

// The frame-budget guard refuses a payload that fits the byte CAP but would
// exceed the RPC frame ceiling once JSON-escaped. A control byte (0x01)
// encodes as the escape sequence \u0001 — 6 JSON characters per 1 raw byte — so a 3 MiB raw
// file of nothing but 0x01 bytes encodes to ~18 MiB, comfortably over
// frameBudgetBytes (~15.94 MiB), while staying well under both the requested
// maxBytes (6 MiB) and maxReadFileCapBytes (12 MiB). This is the scenario
// the guard exists for: a request that the byte-count cap alone would wrongly
// allow through, which would then get silently dropped by writeFrame
// (protocol.go) and hang the caller forever without this check.
func TestReadFileFrameBudgetGuardRefusesEscapeHeavyContent(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping large-fixture test in -short mode")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "escape-heavy.bin")
	size := 3 << 20 // 3 MiB raw
	big := make([]byte, size)
	for i := range big {
		big[i] = 0x01
	}
	if err := os.WriteFile(path, big, 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := handleReadFile(json.RawMessage(`{"path":` + jstr(path) + `,"maxBytes":6291456}`))
	if err != nil {
		t.Fatalf("readFile: %v", err)
	}
	r := res.(readFileResult)
	if !r.Truncated {
		t.Fatalf("expected truncated=true: escape-inflated encoding should exceed the frame budget even though raw size is under the requested cap")
	}
	if r.Content != "" {
		t.Fatalf("expected empty content on refuse, got len=%d", len(r.Content))
	}
	if r.SizeBytes != int64(size) {
		t.Fatalf("sizeBytes = %d, want %d (true raw size, not an encoded/escaped length)", r.SizeBytes, size)
	}
}

func TestReadFileEmptyPath(t *testing.T) {
	if _, err := handleReadFile(json.RawMessage(`{"path":""}`)); err == nil {
		t.Fatal("expected error for empty path")
	}
}

// A relative path is resolved against worktreePath when supplied; absent
// worktreePath keeps the (absolute) path as-given.
func TestReadFileWorktreePath(t *testing.T) {
	worktree := t.TempDir()
	if err := os.WriteFile(filepath.Join(worktree, "data.txt"), []byte("wt-content"), 0o644); err != nil {
		t.Fatal(err)
	}
	params := `{"path":"data.txt","worktreePath":` + jstr(worktree) + `}`
	res, err := handleReadFile(json.RawMessage(params))
	if err != nil {
		t.Fatalf("readFile: %v", err)
	}
	if r := res.(readFileResult); r.Content != "wt-content" {
		t.Fatalf("content = %q, want wt-content", r.Content)
	}
}

// readFile's working-tree path must classify content by the same NUL-byte
// heuristic as electron/main/git/files.ts's looksBinary: text -> isBinary
// false, a NUL byte anywhere in the content -> true. Also proves SizeBytes for
// a binary file is the TRUE on-disk byte count (stat-derived), not something
// computed from Content — the wire value RemoteProvider.readFile (TS) must use
// verbatim instead of Buffer.byteLength over the (possibly U+FFFD-mangled once
// JSON-decoded) content string (br r3s6).
func TestReadFileBinaryDetection(t *testing.T) {
	dir := t.TempDir()

	textPath := filepath.Join(dir, "text.txt")
	textContent := "hello world\n"
	if err := os.WriteFile(textPath, []byte(textContent), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := handleReadFile(json.RawMessage(`{"path":` + jstr(textPath) + `}`))
	if err != nil {
		t.Fatalf("readFile: %v", err)
	}
	if r := res.(readFileResult); r.IsBinary {
		t.Fatalf("expected isBinary=false for text content, got %+v", r)
	} else if r.SizeBytes != int64(len(textContent)) {
		t.Fatalf("sizeBytes = %d, want %d", r.SizeBytes, len(textContent))
	}

	binPath := filepath.Join(dir, "data.bin")
	binContent := append([]byte("PNG\x00fake-binary-marker"), make([]byte, 32)...)
	if err := os.WriteFile(binPath, binContent, 0o644); err != nil {
		t.Fatal(err)
	}
	res, err = handleReadFile(json.RawMessage(`{"path":` + jstr(binPath) + `}`))
	if err != nil {
		t.Fatalf("readFile: %v", err)
	}
	r := res.(readFileResult)
	if !r.IsBinary {
		t.Fatalf("expected isBinary=true for NUL-containing content, got %+v", r)
	}
	// The true byte count, NOT len(r.Content) (which happens to match here since
	// Go strings are byte-for-byte, but the TS layer must use this field rather
	// than re-deriving a size from Content once it crosses the JSON wire).
	if want := int64(len(binContent)); r.SizeBytes != want {
		t.Fatalf("sizeBytes = %d, want %d (true binary file size)", r.SizeBytes, want)
	}
}

// A file that is BOTH larger than maxReadFileBytes AND binary (the realistic
// "large image/binary asset" case) refuses (never truncates) and reports
// SizeBytes as the true full on-disk size. IsBinary is FALSE on this refusal
// — deliberately, NOT a regression: refusing on the working-tree branch means
// never reading the file at all (see effectiveReadCap's refuse branch in
// handleReadFile), so a binary sniff is impossible without defeating the
// point of refusing before reading. This exactly mirrors electron/main/git/
// files.ts's getFile working-tree branch, which returns `isBinary: false`
// unconditionally when `sizeBytes > maxBytes` for the identical reason. (The
// consumer-visible outcome is unaffected either way: RawFile.tsx/
// FoldingView.tsx check `truncated` BEFORE `isBinary`, so this file still
// correctly renders the "too large" placeholder, not a false "not binary"
// claim about content nobody read.) Renamed from the pre-fix
// TestReadFileLargeBinarySizeBytes, which pinned the OLD (sniff-then-
// truncate) contract this leaf replaces — see
// TestReadFileOverCapRefusesWithoutTruncating for the plain-text sibling of
// this same refuse-never-truncate fix.
func TestReadFileLargeBinaryRefusesWithoutSniffing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "large.bin")
	big := make([]byte, maxReadFileBytes+500)
	big[10] = 0 // NUL within the binarySniffBytes prefix -- never actually sniffed
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
	if r.IsBinary {
		t.Fatalf("expected isBinary=false: a refused working-tree read never sniffs (mirrors local's getFile)")
	}
	if r.Content != "" {
		t.Fatalf("expected EMPTY content (refuse, never a truncated prefix), got len=%d", len(r.Content))
	}
	if want := int64(len(big)); r.SizeBytes != want {
		t.Fatalf("sizeBytes = %d, want %d (true size, computed via stat without reading)", r.SizeBytes, want)
	}
}

// A NUL byte beyond the binarySniffBytes-byte prefix must NOT flip isBinary —
// matching electron/main/git/files.ts's looksBinary bound (Math.min(len, 8000))
// exactly, rather than scanning the whole file.
func TestReadFileBinaryDetectionBoundedPrefix(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "mostly-text.bin")
	content := make([]byte, binarySniffBytes+100)
	for i := range content {
		content[i] = 'a'
	}
	content[binarySniffBytes+50] = 0 // NUL past the sniff window
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := handleReadFile(json.RawMessage(`{"path":` + jstr(path) + `}`))
	if err != nil {
		t.Fatalf("readFile: %v", err)
	}
	if r := res.(readFileResult); r.IsBinary {
		t.Fatalf("expected isBinary=false for a NUL beyond the sniff window, got %+v", r)
	}
}

// The ref-read path (`git show <ref>:<path>`) must classify content by the
// same heuristic as the working-tree path.
func TestReadFileRefBinaryDetection(t *testing.T) {
	dir := initRepo(t)
	binPath := filepath.Join(dir, "image.bin")
	binContent := []byte("BIN\x00\x01\x02content")
	if err := os.WriteFile(binPath, binContent, 0o644); err != nil {
		t.Fatal(err)
	}
	gitEnv := append(os.Environ(),
		"GIT_AUTHOR_NAME=test", "GIT_AUTHOR_EMAIL=test@example.com",
		"GIT_COMMITTER_NAME=test", "GIT_COMMITTER_EMAIL=test@example.com",
	)
	addCmd := exec.Command("git", "add", "image.bin")
	addCmd.Dir = dir
	if out, err := addCmd.CombinedOutput(); err != nil {
		t.Fatalf("git add: %v\n%s", err, out)
	}
	commitCmd := exec.Command("git", "commit", "-m", "add binary")
	commitCmd.Dir = dir
	commitCmd.Env = gitEnv
	if out, err := commitCmd.CombinedOutput(); err != nil {
		t.Fatalf("git commit: %v\n%s", err, out)
	}

	res, err := handleReadFile(json.RawMessage(`{"path":"image.bin","ref":"HEAD","cwd":` + jstr(dir) + `}`))
	if err != nil {
		t.Fatalf("readFile: %v", err)
	}
	r := res.(readFileResult)
	if !r.IsBinary {
		t.Fatalf("expected isBinary=true for a binary blob at ref, got %+v", r)
	}
	// SizeBytes at ref is the full blob length (`git show` reproduces the
	// committed bytes verbatim), true regardless of Content's eventual
	// JSON/TS-side handling.
	if want := int64(len(binContent)); r.SizeBytes != want {
		t.Fatalf("sizeBytes = %d, want %d (true blob size)", r.SizeBytes, want)
	}

	// tracked.txt (from initRepo) is text at the same ref.
	res, err = handleReadFile(json.RawMessage(`{"path":"tracked.txt","ref":"HEAD","cwd":` + jstr(dir) + `}`))
	if err != nil {
		t.Fatalf("readFile: %v", err)
	}
	if r := res.(readFileResult); r.IsBinary {
		t.Fatalf("expected isBinary=false for a text blob at ref, got %+v", r)
	}
}

// Over the effective cap via a git-ref read: refuse-never-truncate
// (local_repo_explorer-ftbq) — the SAME contract as the working-tree branch
// (TestReadFileOverCapRefusesWithoutTruncating), exercised through `git show`
// instead of a direct file read. Content is EMPTY (the oversized blob is
// dropped entirely, never a truncated prefix), Truncated is true, and
// SizeBytes is the true full blob length. Unlike the working-tree branch,
// IsBinary IS still correctly reported here (true — this fixture also
// contains a NUL byte): sniffing costs nothing extra on the ref branch
// because the blob is already fully in memory from `git show`, so refusing
// does not need to skip it — mirrors local's getFile ref branch exactly (see
// TestReadFileLargeBinaryRefusesWithoutSniffing for the working-tree branch's
// deliberately different IsBinary=false-on-refuse behavior, and why).
func TestReadFileRefOverCapRefusesWithoutTruncating(t *testing.T) {
	dir := initRepo(t)
	path := filepath.Join(dir, "big.bin")
	big := make([]byte, maxReadFileBytes+500)
	big[10] = 0 // NUL within the binarySniffBytes prefix -> isBinary
	if err := os.WriteFile(path, big, 0o644); err != nil {
		t.Fatal(err)
	}
	commitFile(t, dir, "add big binary", "big.bin")

	res, err := handleReadFile(json.RawMessage(`{"path":"big.bin","ref":"HEAD","cwd":` + jstr(dir) + `}`))
	if err != nil {
		t.Fatalf("readFile: %v", err)
	}
	r := res.(readFileResult)
	if !r.Truncated {
		t.Fatalf("expected truncated=true")
	}
	if r.Content != "" {
		t.Fatalf("expected EMPTY content (refuse, never a truncated prefix), got len=%d", len(r.Content))
	}
	if !r.IsBinary {
		t.Fatalf("expected isBinary=true: the ref branch sniffs before deciding to refuse (blob already in memory)")
	}
	if want := int64(len(big)); r.SizeBytes != want {
		t.Fatalf("sizeBytes = %d, want %d (true blob size)", r.SizeBytes, want)
	}
}

// commitFile stages and commits path (relative to dir) with fixed author
// identity — shared setup for the handleReadFileBytes tests below.
func commitFile(t *testing.T, dir, message string, paths ...string) {
	t.Helper()
	addArgs := append([]string{"add"}, paths...)
	addCmd := exec.Command("git", addArgs...)
	addCmd.Dir = dir
	if out, err := addCmd.CombinedOutput(); err != nil {
		t.Fatalf("git add: %v\n%s", err, out)
	}
	commitCmd := exec.Command("git", "commit", "-m", message)
	commitCmd.Dir = dir
	commitCmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=test", "GIT_AUTHOR_EMAIL=test@example.com",
		"GIT_COMMITTER_NAME=test", "GIT_COMMITTER_EMAIL=test@example.com",
	)
	if out, err := commitCmd.CombinedOutput(); err != nil {
		t.Fatalf("git commit: %v\n%s", err, out)
	}
}

// handleReadFileBytes (br bn8a) — the byte-safe git-ref branch of the
// binary-preview read primitive. Round-trips a committed binary blob
// byte-identically via the []byte result field (never the string Content
// field readFile uses, which corrupts invalid UTF-8 — br r3s6).
func TestReadFileBytesRef(t *testing.T) {
	dir := initRepo(t)
	binContent := []byte{0x89, 'P', 'N', 'G', 0x00, 0x01, 0x02, 0xff, 0xfe, 0x00}
	if err := os.WriteFile(filepath.Join(dir, "image.bin"), binContent, 0o644); err != nil {
		t.Fatal(err)
	}
	commitFile(t, dir, "add binary", "image.bin")

	res, err := handleReadFileBytes(json.RawMessage(`{"path":"image.bin","ref":"HEAD","cwd":` + jstr(dir) + `}`))
	if err != nil {
		t.Fatalf("readFileBytes: %v", err)
	}
	r := res.(readFileBytesResult)
	if r.Reason != "" || !r.Exists {
		t.Fatalf("unexpected refusal: %+v", r)
	}
	if !bytes.Equal(r.BytesBase64, binContent) {
		t.Fatalf("bytes = %v, want %v", r.BytesBase64, binContent)
	}
	if r.SizeBytes != int64(len(binContent)) {
		t.Fatalf("sizeBytes = %d, want %d", r.SizeBytes, len(binContent))
	}
}

// A path absent at the given ref (e.g. an added file with no baseline
// version) must resolve reason="missing" — never an RPC-level error — so the
// TS side maps it to useImageBytes' existing 'absent' state instead of
// 'unreadable'.
func TestReadFileBytesMissingAtRef(t *testing.T) {
	dir := initRepo(t)
	res, err := handleReadFileBytes(json.RawMessage(`{"path":"nope.png","ref":"HEAD","cwd":` + jstr(dir) + `}`))
	if err != nil {
		t.Fatalf("readFileBytes: %v", err)
	}
	r := res.(readFileBytesResult)
	if r.Reason != "missing" || r.Exists {
		t.Fatalf("expected reason=missing, exists=false; got %+v", r)
	}
	if r.BytesBase64 != nil {
		t.Fatalf("expected nil bytes for a missing-at-ref result, got %v", r.BytesBase64)
	}
}

// Over maxRefBytesCap: refuse with metadata only (true blob size), never a
// truncated prefix — the SAME refuse-never-truncate contract as the fs/SFTP
// branches of readFileBytes, applied to the ref branch too (no weaker cap).
func TestReadFileBytesOverCap(t *testing.T) {
	dir := initRepo(t)
	big := make([]byte, maxRefBytesCap+100)
	for i := range big {
		big[i] = 'a'
	}
	if err := os.WriteFile(filepath.Join(dir, "big.bin"), big, 0o644); err != nil {
		t.Fatal(err)
	}
	commitFile(t, dir, "add big file", "big.bin")

	res, err := handleReadFileBytes(json.RawMessage(`{"path":"big.bin","ref":"HEAD","cwd":` + jstr(dir) + `}`))
	if err != nil {
		t.Fatalf("readFileBytes: %v", err)
	}
	r := res.(readFileBytesResult)
	if r.Reason != "too-large" || !r.Exists {
		t.Fatalf("expected reason=too-large, exists=true; got Reason=%q Exists=%v", r.Reason, r.Exists)
	}
	if r.BytesBase64 != nil {
		t.Fatalf("expected refuse-never-truncate: nil bytes over cap, got %d bytes", len(r.BytesBase64))
	}
	if r.SizeBytes != int64(len(big)) {
		t.Fatalf("sizeBytes = %d, want %d (true blob size)", r.SizeBytes, len(big))
	}
}

func TestReadFileBytesEmptyParams(t *testing.T) {
	if _, err := handleReadFileBytes(json.RawMessage(`{"path":"","ref":"HEAD","cwd":"/tmp"}`)); err == nil {
		t.Fatal("expected error for empty path")
	}
	if _, err := handleReadFileBytes(json.RawMessage(`{"path":"a.png","ref":"","cwd":"/tmp"}`)); err == nil {
		t.Fatal("expected error for empty ref")
	}
	if _, err := handleReadFileBytes(json.RawMessage(`{"path":"a.png","ref":"HEAD","cwd":""}`)); err == nil {
		t.Fatal("expected error for empty cwd")
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

// A relative dir is resolved against worktreePath when supplied, and entry paths
// stay base-relative (root == the worktree base).
func TestListDirWorktreePath(t *testing.T) {
	worktree := t.TempDir()
	if err := os.MkdirAll(filepath.Join(worktree, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(worktree, "src", "a.txt"), []byte("a"), 0o644); err != nil {
		t.Fatal(err)
	}
	params := `{"dir":"src","root":` + jstr(worktree) + `,"worktreePath":` + jstr(worktree) + `}`
	raw, err := handleListDir(json.RawMessage(params))
	if err != nil {
		t.Fatalf("listDir: %v", err)
	}
	entries := raw.([]dirEntry)
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d: %+v", len(entries), entries)
	}
	if entries[0].Name != "a.txt" || entries[0].Path != "src/a.txt" {
		t.Fatalf("expected src/a.txt, got %+v", entries[0])
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

// --- handleGetDiffBundle (local_repo_explorer-1jpc, amendment 1) ---
//
// Server-side counterpart to LocalProvider.getDiffBundle's `ref: baseline ||
// 'HEAD'` fix: when no explicit Baseline is supplied (the app's default
// "Working tree vs HEAD" diff target), the old-side read must still resolve
// against HEAD instead of being skipped, while the patch-generation branch
// (git's own diff default: index vs working tree) stays untouched.

// stageFile stages path (relative to dir) into the index WITHOUT committing —
// used to set up a staged-vs-unstaged split for the patch-args regression
// guard below.
func stageFile(t *testing.T, dir string, paths ...string) {
	t.Helper()
	addArgs := append([]string{"add"}, paths...)
	addCmd := exec.Command("git", addArgs...)
	addCmd.Dir = dir
	if out, err := addCmd.CombinedOutput(); err != nil {
		t.Fatalf("git add: %v\n%s", err, out)
	}
}

// TestGetDiffBundleDefaultBaseline pins the two shapes amendment 1 must
// distinguish, IN THE SAME test run: an empty Baseline resolves old content
// at HEAD when the file exists there, and still resolves no old content —
// for the RIGHT reason, a real absent-at-HEAD gitShowCapped failure, not a
// blanket skip — when the file is genuinely new.
func TestGetDiffBundleDefaultBaseline(t *testing.T) {
	t.Run("file exists at HEAD", func(t *testing.T) {
		dir := initRepo(t) // commits tracked.txt = "hello\n"
		if err := os.WriteFile(filepath.Join(dir, "tracked.txt"), []byte("hello\nworld\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		res, err := handleGetDiffBundle(json.RawMessage(`{"cwd":` + jstr(dir) + `,"path":"tracked.txt"}`))
		if err != nil {
			t.Fatalf("getDiffBundle: %v", err)
		}
		r := res.(getDiffBundleResult)
		if !r.OldReadable {
			t.Fatalf("expected OldReadable=true for a file present at HEAD with empty Baseline, got %+v", r)
		}
		if r.OldContent != "hello\n" {
			t.Fatalf("OldContent = %q, want %q (HEAD content)", r.OldContent, "hello\n")
		}
		if r.OldTruncated {
			t.Fatalf("unexpected truncation: %+v", r)
		}
		if !r.NewReadable || r.NewContent != "hello\nworld\n" {
			t.Fatalf("unexpected new side: %+v", r)
		}
		if !strings.Contains(r.Patch, "+world") {
			t.Fatalf("expected patch to contain the working-tree addition, got:\n%s", r.Patch)
		}
	})

	t.Run("genuinely new file absent at HEAD", func(t *testing.T) {
		dir := initRepo(t)
		if err := os.WriteFile(filepath.Join(dir, "new.txt"), []byte("brand new\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		res, err := handleGetDiffBundle(json.RawMessage(`{"cwd":` + jstr(dir) + `,"path":"new.txt"}`))
		if err != nil {
			t.Fatalf("getDiffBundle: %v", err)
		}
		r := res.(getDiffBundleResult)
		if r.OldReadable {
			t.Fatalf("expected OldReadable=false for a file absent at HEAD (real absent-at-ref detection, not a blanket skip), got %+v", r)
		}
		if r.OldContent != "" {
			t.Fatalf("expected empty OldContent for a file absent at HEAD, got %q", r.OldContent)
		}
		if !r.NewReadable || r.NewContent != "brand new\n" {
			t.Fatalf("unexpected new side: %+v", r)
		}
	})
}

// TestGetDiffBundleExplicitBaselineUnchanged pins that an explicit Baseline
// (e.g. a Branch-point ref) still reads old content AT that ref, not HEAD —
// pre-existing behavior the amendment-1 fix must not regress.
func TestGetDiffBundleExplicitBaselineUnchanged(t *testing.T) {
	dir := initRepo(t) // commit 1: tracked.txt = "hello\n"

	revParse := exec.Command("git", "rev-parse", "HEAD")
	revParse.Dir = dir
	out, err := revParse.CombinedOutput()
	if err != nil {
		t.Fatalf("git rev-parse HEAD: %v\n%s", err, out)
	}
	firstSHA := strings.TrimSpace(string(out))

	// Commit 2 moves HEAD past the captured baseline.
	if err := os.WriteFile(filepath.Join(dir, "tracked.txt"), []byte("hello\nsecond\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	commitFile(t, dir, "second commit", "tracked.txt")

	// Uncommitted working-tree edit on top of commit 2.
	if err := os.WriteFile(filepath.Join(dir, "tracked.txt"), []byte("hello\nsecond\nthird\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	res, err := handleGetDiffBundle(json.RawMessage(`{"cwd":` + jstr(dir) + `,"path":"tracked.txt","baseline":` + jstr(firstSHA) + `}`))
	if err != nil {
		t.Fatalf("getDiffBundle: %v", err)
	}
	r := res.(getDiffBundleResult)
	if !r.OldReadable || r.OldContent != "hello\n" {
		t.Fatalf("expected old content read AT the explicit baseline (commit 1), got OldReadable=%v OldContent=%q", r.OldReadable, r.OldContent)
	}
	if !strings.Contains(r.Patch, "+second") {
		t.Fatalf("expected patch computed against the explicit baseline, got:\n%s", r.Patch)
	}
}

// TestGetDiffBundlePatchUnchangedByFix is the patch-args regression guard:
// the patch-generation branch (git's own diff default — index vs working
// tree) must be unaffected by the old-side HEAD default this fix
// introduces. A staged addition is deliberately invisible to `git diff`
// with no baseline (it's already in the index); if a future edit ever
// widened the HEAD default to the patch args too, the staged line would
// wrongly appear in the returned Patch.
func TestGetDiffBundlePatchUnchangedByFix(t *testing.T) {
	dir := initRepo(t) // tracked.txt = "hello\n" at HEAD

	// Stage one addition (index now differs from HEAD; working tree == index).
	if err := os.WriteFile(filepath.Join(dir, "tracked.txt"), []byte("hello\nalpha-staged\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	stageFile(t, dir, "tracked.txt")

	// Then make a further, UNSTAGED edit on top (working tree now differs
	// from the index too).
	if err := os.WriteFile(filepath.Join(dir, "tracked.txt"), []byte("hello\nalpha-staged\nbeta-unstaged\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	res, err := handleGetDiffBundle(json.RawMessage(`{"cwd":` + jstr(dir) + `,"path":"tracked.txt"}`))
	if err != nil {
		t.Fatalf("getDiffBundle: %v", err)
	}
	r := res.(getDiffBundleResult)

	// Patch guardrail: git's default `git diff` (no baseline) compares the
	// INDEX to the working tree, so only the unstaged line is new — the
	// staged line is already in the index and must NOT appear as an
	// addition. This is exactly today's pre-fix behavior for the args
	// branch (untouched by this change): a regression that defaulted
	// Baseline to HEAD for patch generation too would make "alpha-staged"
	// show up as an addition as well.
	if !strings.Contains(r.Patch, "+beta-unstaged") {
		t.Fatalf("expected patch to show the unstaged addition, got:\n%s", r.Patch)
	}
	if strings.Contains(r.Patch, "+alpha-staged") {
		t.Fatalf("patch must not show the already-staged line as an addition (would indicate the patch-args branch regressed to a HEAD default), got:\n%s", r.Patch)
	}

	// Old-side guardrail: the OLD side still defaults to HEAD regardless of
	// the staged index — this is the fix's own new behavior, independent of
	// the untouched patch-args branch above.
	if !r.OldReadable || r.OldContent != "hello\n" {
		t.Fatalf("expected old content read at HEAD despite staged changes, got OldReadable=%v OldContent=%q", r.OldReadable, r.OldContent)
	}
}
