package main

// Scenario 14 (helper side): directory and symlink creation with lstat checks and
// an atomic retarget of the fixed-name per-os/arch link.

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
)

func TestCockpitLinkPathIsPerOSAndArch(t *testing.T) {
	a := cockpitLinkPath("/home/ann", "linux", "amd64")
	b := cockpitLinkPath("/home/ann", "linux", "arm64")
	c := cockpitLinkPath("/home/ann", "darwin", "arm64")
	if a != "/home/ann/.agent-cockpit/bin/linux-amd64/cockpit" {
		t.Fatalf("link path = %s", a)
	}
	if a == b || b == c {
		t.Fatal("hosts of different architectures sharing one home must not share a link")
	}
	if filepath.Base(a) != "cockpit" {
		t.Fatalf("the link itself must be named cockpit (dispatch keys on the program name): %s", a)
	}
}

func TestEnsureCockpitLinkCreatesPrivateDirectoriesAndTheLink(t *testing.T) {
	home := shortDir(t)
	exe := "/opt/helper/helper-0.1.0-linux-amd64"
	link, err := ensureCockpitLink(home, exe, "linux", "amd64", os.Getuid())
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(home, ".agent-cockpit", "bin", "linux-amd64", "cockpit"); link != want {
		t.Fatalf("link = %s, want %s", link, want)
	}
	if target, err := os.Readlink(link); err != nil || target != exe {
		t.Fatalf("readlink = %q %v, want %s", target, err, exe)
	}
	for _, dir := range []string{
		filepath.Join(home, ".agent-cockpit", "bin"),
		filepath.Join(home, ".agent-cockpit", "bin", "linux-amd64"),
	} {
		if got := mode(t, dir); got != 0o700 {
			t.Fatalf("%s mode = %o, want 700", dir, got)
		}
	}
}

func TestEnsureCockpitLinkIsIdempotent(t *testing.T) {
	home := shortDir(t)
	exe := "/opt/helper/helper-0.1.0-linux-amd64"
	link, err := ensureCockpitLink(home, exe, "linux", "amd64", os.Getuid())
	if err != nil {
		t.Fatal(err)
	}
	before, _ := os.Lstat(link)
	for i := 0; i < 3; i++ {
		again, err := ensureCockpitLink(home, exe, "linux", "amd64", os.Getuid())
		if err != nil || again != link {
			t.Fatalf("call %d: %s %v", i, again, err)
		}
	}
	after, _ := os.Lstat(link)
	if !os.SameFile(before, after) {
		t.Fatal("an up-to-date link must be left untouched, not replaced")
	}
	assertNoTempLinks(t, filepath.Dir(link))
}

func assertNoTempLinks(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), ".tmp-") {
			t.Fatalf("temp link %s left behind in %s", e.Name(), dir)
		}
	}
}

func TestEnsureCockpitLinkReplacesAStaleTarget(t *testing.T) {
	home := shortDir(t)
	uid := os.Getuid()
	link, err := ensureCockpitLink(home, "/opt/old/helper", "linux", "amd64", uid)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ensureCockpitLink(home, "/opt/new/helper", "linux", "amd64", uid); err != nil {
		t.Fatal(err)
	}
	if target, _ := os.Readlink(link); target != "/opt/new/helper" {
		t.Fatalf("target = %s, want the new helper", target)
	}
	assertNoTempLinks(t, filepath.Dir(link))
}

func TestEnsureCockpitLinkReplaceIsAtomic(t *testing.T) {
	// A pane running the CLI while the helper re-links must never find the link
	// missing: the replacement is a temp link renamed over the old one.
	home := shortDir(t)
	uid := os.Getuid()
	link, err := ensureCockpitLink(home, "/opt/a/helper", "linux", "amd64", uid)
	if err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	var wg sync.WaitGroup
	var missing int
	var mu sync.Mutex
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			if _, err := os.Readlink(link); err != nil {
				mu.Lock()
				missing++
				mu.Unlock()
			}
		}
	}()
	for i := 0; i < 300; i++ {
		target := "/opt/a/helper"
		if i%2 == 1 {
			target = "/opt/b/helper"
		}
		if _, err := ensureCockpitLink(home, target, "linux", "amd64", uid); err != nil {
			t.Fatal(err)
		}
	}
	close(stop)
	wg.Wait()
	if missing != 0 {
		t.Fatalf("the link was missing %d times while being replaced", missing)
	}
	assertNoTempLinks(t, filepath.Dir(link))
}

func TestEnsureCockpitLinkKeepsOSAndArchApart(t *testing.T) {
	home := shortDir(t)
	uid := os.Getuid()
	a, err := ensureCockpitLink(home, "/opt/h-linux-amd64", "linux", "amd64", uid)
	if err != nil {
		t.Fatal(err)
	}
	b, err := ensureCockpitLink(home, "/opt/h-linux-arm64", "linux", "arm64", uid)
	if err != nil {
		t.Fatal(err)
	}
	ta, _ := os.Readlink(a)
	tb, _ := os.Readlink(b)
	if a == b || ta == tb {
		t.Fatalf("two architectures sharing a home share a link: %s -> %s, %s -> %s", a, ta, b, tb)
	}
}

func TestEnsureCockpitLinkFailsClosedOnUnsafeDirectories(t *testing.T) {
	uid := os.Getuid()
	exe := "/opt/helper"
	t.Run("a symlinked bin directory", func(t *testing.T) {
		home := shortDir(t)
		elsewhere := filepath.Join(shortDir(t), "bin")
		if err := os.Mkdir(elsewhere, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Join(home, ".agent-cockpit"), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(elsewhere, filepath.Join(home, ".agent-cockpit", "bin")); err != nil {
			t.Fatal(err)
		}
		if _, err := ensureCockpitLink(home, exe, "linux", "amd64", uid); err == nil {
			t.Fatal("a symlinked bin directory must fail closed")
		}
		if entries, _ := os.ReadDir(elsewhere); len(entries) != 0 {
			t.Fatal("nothing may be written through a symlinked directory")
		}
	})
	t.Run("a directory open to the group", func(t *testing.T) {
		home := shortDir(t)
		archDir := filepath.Join(home, ".agent-cockpit", "bin", "linux-amd64")
		if err := os.MkdirAll(archDir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(archDir, 0o770); err != nil {
			t.Fatal(err)
		}
		if _, err := ensureCockpitLink(home, exe, "linux", "amd64", uid); err == nil {
			t.Fatal("a group-accessible link directory must fail closed")
		}
	})
	t.Run("a directory owned by someone else", func(t *testing.T) {
		home := shortDir(t)
		st, err := os.Stat(home)
		if err != nil {
			t.Fatal(err)
		}
		if int(st.Sys().(*syscall.Stat_t).Uid) != uid {
			t.Skip("the test directory is not owned by the test user")
		}
		if _, err := ensureCockpitLink(home, exe, "linux", "amd64", uid+1); err == nil {
			t.Fatal("a directory owned by another uid must fail closed")
		}
	})
}

func TestEnsureCockpitLinkRejectsBadInputs(t *testing.T) {
	uid := os.Getuid()
	if _, err := ensureCockpitLink("", "/opt/helper", "linux", "amd64", uid); err == nil {
		t.Fatal("no home directory must be an error")
	}
	if _, err := ensureCockpitLink(shortDir(t), "relative/helper", "linux", "amd64", uid); err == nil {
		t.Fatal("a relative helper path must be an error: the link must be absolute")
	}
}
