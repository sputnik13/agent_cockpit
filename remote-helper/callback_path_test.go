package main

// Scenario 5 (remote side): socket path derivation and directory checks. The
// local counterpart is electron/main/callback/socketPath.test.ts.

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestProjectAndHostHashesMatchTheTypeScriptReference(t *testing.T) {
	// Vectors computed with Node's crypto (projectHash in socketPath.ts): the
	// first 12 hex characters of SHA-256(projectId), UTF-8.
	projects := map[string]string{
		"project-a":             "0e3ffbf31db2",
		"proj/with space":       "144f752eb730",
		"日本語-プロジェクト":            "bc798637ad02",
		"":                      "e3b0c44298fc",
		"not-the-first-project": callbackProjectHash("not-the-first-project"),
	}
	for project, want := range projects {
		if got := callbackProjectHash(project); got != want {
			t.Fatalf("callbackProjectHash(%q) = %s, want %s", project, got, want)
		}
	}
	if got := callbackHostHash("devbox.example.com"); got != "6bde9ba0" {
		t.Fatalf("callbackHostHash = %s, want 6bde9ba0", got)
	}
	if len(callbackHostHash("x")) != 8 || len(callbackProjectHash("x")) != 12 {
		t.Fatal("host hash is 8 hex characters, project hash 12")
	}
}

func baseOptions() callbackLocationOptions {
	return callbackLocationOptions{
		projectID: "project-a",
		hostname:  "devbox.example.com",
		home:      "/home/ann",
		uid:       1000,
	}
}

func TestLocationUsesHomeWhenThereIsNoRuntimeDir(t *testing.T) {
	got, err := deriveCallbackLocation(baseOptions())
	if err != nil {
		t.Fatal(err)
	}
	wantDir := "/home/ann/.agent-cockpit/callback"
	wantSock := wantDir + "/6bde9ba0-0e3ffbf31db2.sock"
	if got.dir != wantDir || got.socketPath != wantSock || got.fallback {
		t.Fatalf("got %+v, want %s in %s, no fallback", got, wantSock, wantDir)
	}
}

func TestLocationPrefersTheRuntimeDir(t *testing.T) {
	opts := baseOptions()
	opts.xdgRuntimeDir = "/run/user/1000"
	got, err := deriveCallbackLocation(opts)
	if err != nil {
		t.Fatal(err)
	}
	if got.dir != "/run/user/1000/agent-cockpit/callback" ||
		got.socketPath != "/run/user/1000/agent-cockpit/callback/6bde9ba0-0e3ffbf31db2.sock" || got.fallback {
		t.Fatalf("got %+v", got)
	}
}

func TestLocationIgnoresARelativeRuntimeDir(t *testing.T) {
	opts := baseOptions()
	opts.xdgRuntimeDir = "run/user/1000"
	got, err := deriveCallbackLocation(opts)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(got.socketPath, "/home/ann/.agent-cockpit/callback/") {
		t.Fatalf("a relative XDG_RUNTIME_DIR must be ignored: %+v", got)
	}
}

func TestTwoHostsSharingAHomeNeverShareASocketName(t *testing.T) {
	a, b := baseOptions(), baseOptions()
	b.hostname = "other-host"
	la, _ := deriveCallbackLocation(a)
	lb, _ := deriveCallbackLocation(b)
	if la.socketPath == lb.socketPath {
		t.Fatalf("hosts %q and %q share %s", a.hostname, b.hostname, la.socketPath)
	}
	if filepath.Dir(la.socketPath) != filepath.Dir(lb.socketPath) {
		t.Fatal("a shared home keeps both sockets in the same directory; only the name differs")
	}
}

func TestTwoProjectsOnOneHostNeverShareASocket(t *testing.T) {
	a, b := baseOptions(), baseOptions()
	b.projectID = "project-b"
	la, _ := deriveCallbackLocation(a)
	lb, _ := deriveCallbackLocation(b)
	if la.socketPath == lb.socketPath {
		t.Fatal("two projects must have two sockets")
	}
}

func TestLocationFallsBackToTmpPastTheNinetyByteGuard(t *testing.T) {
	opts := baseOptions()
	opts.home = "/home/" + strings.Repeat("a-very-long-username", 4)
	opts.tmpRoot = "/tmp"
	got, err := deriveCallbackLocation(opts)
	if err != nil {
		t.Fatal(err)
	}
	if !got.fallback || got.dir != "/tmp/ac-cb-1000" ||
		got.socketPath != "/tmp/ac-cb-1000/6bde9ba0-0e3ffbf31db2.sock" {
		t.Fatalf("got %+v, want the /tmp/ac-cb-<uid> fallback", got)
	}
	if len(got.socketPath) > callbackSocketPathGuardBytes {
		t.Fatalf("fallback path is %d bytes", len(got.socketPath))
	}
}

func TestTheGuardIsInclusiveAtNinetyBytes(t *testing.T) {
	opts := baseOptions()
	name := "/6bde9ba0-0e3ffbf31db2.sock"
	suffix := "/.agent-cockpit/callback" + name
	opts.home = "/" + strings.Repeat("h", callbackSocketPathGuardBytes-len(suffix)-1)
	got, err := deriveCallbackLocation(opts)
	if err != nil || got.fallback || len(got.socketPath) != callbackSocketPathGuardBytes {
		t.Fatalf("a %d-byte path is at the guard and must stay primary: %+v err=%v",
			callbackSocketPathGuardBytes, got, err)
	}
	opts.home += "h"
	got, err = deriveCallbackLocation(opts)
	if err != nil || !got.fallback {
		t.Fatalf("one byte over must fall back: %+v err=%v", got, err)
	}
}

func TestLocationGuardCountsBytesNotCharacters(t *testing.T) {
	opts := baseOptions()
	opts.home = "/" + strings.Repeat("日", 20) // 60 bytes, 20 characters
	got, err := deriveCallbackLocation(opts)
	if err != nil || !got.fallback {
		t.Fatalf("a multi-byte home pushes the path over the byte guard: %+v err=%v", got, err)
	}
}

func TestLocationFallsBackWhenThePathCannotBeInjected(t *testing.T) {
	opts := baseOptions()
	opts.home = "/home/a\nb"
	got, err := deriveCallbackLocation(opts)
	if err != nil || !got.fallback || strings.ContainsAny(got.socketPath, "\n\r\x00") {
		t.Fatalf("a line break in the home path must use the fallback: %+v err=%v", got, err)
	}
}

func TestLocationFallsBackWithoutAHomeOrRuntimeDir(t *testing.T) {
	opts := baseOptions()
	opts.home = ""
	got, err := deriveCallbackLocation(opts)
	if err != nil || !got.fallback {
		t.Fatalf("no home and no runtime dir must use the fallback: %+v err=%v", got, err)
	}
}

func TestLocationFailsOnlyWhenEvenTheFallbackIsUnusable(t *testing.T) {
	opts := baseOptions()
	opts.home = ""
	opts.tmpRoot = "/" + strings.Repeat("t", 100)
	_, err := deriveCallbackLocation(opts)
	var pathErr *callbackPathError
	if !asPathError(err, &pathErr) || pathErr.code != pathTooLong {
		t.Fatalf("err = %v, want too-long", err)
	}
	opts.tmpRoot = "/tmp\nroot"
	_, err = deriveCallbackLocation(opts)
	if !asPathError(err, &pathErr) || pathErr.code != pathInvalidValue {
		t.Fatalf("err = %v, want invalid-value", err)
	}
}

func asPathError(err error, target **callbackPathError) bool {
	pe, ok := err.(*callbackPathError)
	if ok {
		*target = pe
	}
	return ok
}

func TestFallbackDirIsPerUser(t *testing.T) {
	a, b := baseOptions(), baseOptions()
	a.home, b.home = "", ""
	b.uid = 1001
	la, _ := deriveCallbackLocation(a)
	lb, _ := deriveCallbackLocation(b)
	if la.dir == lb.dir {
		t.Fatalf("two users share %s", la.dir)
	}
}

// ---- Directory checks ---------------------------------------------------------

func mode(t *testing.T, path string) os.FileMode {
	t.Helper()
	fi, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	return fi.Mode().Perm()
}

func TestPreparePrivateDirCreatesItOwnerOnlyAndIsIdempotent(t *testing.T) {
	root := shortDir(t)
	dir := filepath.Join(root, "a", "b", "callback")
	uid := os.Getuid()
	if err := preparePrivateDir(dir, uid); err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{filepath.Join(root, "a"), filepath.Join(root, "a", "b"), dir} {
		if got := mode(t, d); got != 0o700 {
			t.Fatalf("%s mode = %o, want 700", d, got)
		}
	}
	if err := preparePrivateDir(dir, uid); err != nil {
		t.Fatalf("a second call must succeed: %v", err)
	}
}

func TestPreparePrivateDirLeavesExistingParentsAlone(t *testing.T) {
	root := shortDir(t)
	parent := filepath.Join(root, "shared")
	if err := os.Mkdir(parent, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(parent, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := preparePrivateDir(filepath.Join(parent, "callback"), os.Getuid()); err != nil {
		t.Fatal(err)
	}
	if got := mode(t, parent); got != 0o755 {
		t.Fatalf("a pre-existing parent's mode was changed to %o", got)
	}
}

func TestPreparePrivateDirFailsClosed(t *testing.T) {
	uid := os.Getuid()
	cases := map[string]func(t *testing.T, dir string) (target string, wantUID int){
		"a symlink to a directory": func(t *testing.T, dir string) (string, int) {
			real := filepath.Join(dir, "real")
			if err := os.Mkdir(real, 0o700); err != nil {
				t.Fatal(err)
			}
			link := filepath.Join(dir, "link")
			if err := os.Symlink(real, link); err != nil {
				t.Fatal(err)
			}
			return link, uid
		},
		"a regular file": func(t *testing.T, dir string) (string, int) {
			file := filepath.Join(dir, "file")
			if err := os.WriteFile(file, nil, 0o600); err != nil {
				t.Fatal(err)
			}
			return file, uid
		},
		"a directory open to the group": func(t *testing.T, dir string) (string, int) {
			d := filepath.Join(dir, "open")
			if err := os.Mkdir(d, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(d, 0o750); err != nil {
				t.Fatal(err)
			}
			return d, uid
		},
		"a directory open to others": func(t *testing.T, dir string) (string, int) {
			d := filepath.Join(dir, "world")
			if err := os.Mkdir(d, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(d, 0o705); err != nil {
				t.Fatal(err)
			}
			return d, uid
		},
		"a directory owned by someone else": func(t *testing.T, dir string) (string, int) {
			d := filepath.Join(dir, "theirs")
			if err := os.Mkdir(d, 0o700); err != nil {
				t.Fatal(err)
			}
			return d, uid + 1 // the check compares against the expected owner
		},
	}
	for name, setup := range cases {
		t.Run(name, func(t *testing.T) {
			target, wantUID := setup(t, shortDir(t))
			err := preparePrivateDir(target, wantUID)
			var pathErr *callbackPathError
			if !asPathError(err, &pathErr) {
				t.Fatalf("err = %v, want a callbackPathError", err)
			}
			if pathErr.code != pathUnsafeDir && pathErr.code != pathDirError {
				t.Fatalf("code = %s", pathErr.code)
			}
		})
	}
}

func TestPreparePrivateDirReportsTheOwner(t *testing.T) {
	dir := filepath.Join(shortDir(t), "x")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	st, err := os.Lstat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if int(st.Sys().(*syscall.Stat_t).Uid) != os.Getuid() {
		t.Skip("the test directory is not owned by the test user")
	}
	err = preparePrivateDir(dir, os.Getuid()+1)
	if err == nil || !strings.Contains(err.Error(), "owned by uid") {
		t.Fatalf("err = %v, want an ownership message", err)
	}
}
