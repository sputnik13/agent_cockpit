package daemon

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOpenHomeCreatesPrivateDirectory(t *testing.T) {
	t.Parallel()

	home, err := OpenHome(filepath.Join(t.TempDir(), "mux"))
	if err != nil {
		t.Fatalf("OpenHome() error = %v", err)
	}
	info, err := os.Stat(home.Path)
	if err != nil {
		t.Fatalf("stat created home: %v", err)
	}
	if got := info.Mode().Perm(); got != 0o700 {
		t.Fatalf("home permissions = %#o, want 0700", got)
	}
}

func TestOpenHomeRejectsGroupAccessibleDirectory(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "mux")
	if err := os.Mkdir(path, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenHome(path); err == nil {
		t.Fatal("OpenHome() error = nil, want private-directory rejection")
	}
}

func TestSocketPathMovesOnlyOverlongHomesToPrivateRuntimeDirectory(t *testing.T) {
	short, shortRuntime := SocketPath("/tmp/cockpit-mux")
	if short != "/tmp/cockpit-mux/mux.sock" || shortRuntime != "" {
		t.Fatalf("short SocketPath = (%q, %q)", short, shortRuntime)
	}

	home := "/private/var/folders/" + strings.Repeat("long-home-", 16)
	path, runtime := SocketPath(home)
	if runtime == "" || !strings.HasPrefix(path, runtime+string(filepath.Separator)) {
		t.Fatalf("overlong SocketPath = (%q, %q)", path, runtime)
	}
	if len(filepath.Base(path)) != 29 || filepath.Ext(path) != ".sock" {
		t.Fatalf("overlong socket name = %q", filepath.Base(path))
	}
	again, _ := SocketPath(home)
	if path != again {
		t.Fatalf("SocketPath is not deterministic: %q != %q", path, again)
	}
}
