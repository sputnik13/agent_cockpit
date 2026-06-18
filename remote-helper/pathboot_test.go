package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMergePathDirsOrderPreservingDedup(t *testing.T) {
	got := mergePathDirs("/a:/b", "/b:/c", "", "/a:/d")
	want := "/a:/b:/c:/d"
	if got != want {
		t.Fatalf("mergePathDirs: want %q got %q", want, got)
	}
}

func TestStaticPathDirsIncludesUserLocalBin(t *testing.T) {
	dirs := staticPathDirs("/home/u")
	joined := strings.Join(dirs, ":")
	for _, want := range []string{"/opt/homebrew/bin", "/usr/local/bin", "/home/u/.local/bin"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("staticPathDirs missing %q: %v", want, dirs)
		}
	}
}

// writeFakeShell creates an executable that ignores its args and prints a
// marker-wrapped PATH, standing in for `$SHELL -ilc 'printf …$PATH…'`.
func writeFakeShell(t *testing.T, fakePath string) string {
	t.Helper()
	dir := t.TempDir()
	sh := filepath.Join(dir, "fakeshell")
	body := "#!/bin/sh\nprintf '__AC_PATH__%s__AC_PATH__' '" + fakePath + "'\n"
	if err := os.WriteFile(sh, []byte(body), 0o755); err != nil {
		t.Fatalf("write fake shell: %v", err)
	}
	return sh
}

func TestImportLoginShellPathParsesMarkers(t *testing.T) {
	t.Setenv("SHELL", writeFakeShell(t, "/opt/login/bin:/usr/bin"))
	if got := importLoginShellPath(); got != "/opt/login/bin:/usr/bin" {
		t.Fatalf("importLoginShellPath: got %q", got)
	}
}

func TestImportLoginShellPathEmptyWhenNoShell(t *testing.T) {
	t.Setenv("SHELL", "")
	if got := importLoginShellPath(); got != "" {
		t.Fatalf("expected empty, got %q", got)
	}
}

func TestBootstrapPathUnionsLoginStaticAndExisting(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("SHELL", writeFakeShell(t, "/opt/login/bin"))
	t.Setenv("PATH", "/usr/bin:/bin")

	bootstrapPath()
	got := os.Getenv("PATH")
	dirs := filepath.SplitList(got)

	// login-shell dir wins (first), then a static dir (~/.local/bin), then prior.
	if len(dirs) == 0 || dirs[0] != "/opt/login/bin" {
		t.Fatalf("expected login dir first, got %v", dirs)
	}
	mustContain := []string{"/opt/login/bin", filepath.Join(home, ".local", "bin"), "/usr/bin", "/bin"}
	for _, w := range mustContain {
		found := false
		for _, d := range dirs {
			if d == w {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("PATH missing %q: %v", w, dirs)
		}
	}
}
