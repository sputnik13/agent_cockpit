package main

// PATH bootstrap for the remote helper — the remote-host counterpart of the
// desktop app's electron/main/pathBootstrap.ts. The helper is launched over a
// NON-login ssh exec channel, whose PATH is the sshd default
// (/usr/bin:/bin:/usr/sbin:/sbin) and omits ~/.local/bin, Homebrew, and any
// version-manager (mise/asdf/nvm) dirs. So tools the helper spawns by bare name
// (br, git) ENOENT even when installed. bootstrapPath() fixes the helper
// process's own PATH once at startup — exactly like the local bootstrap — so all
// bare-name execs resolve, rather than each call site searching dirs itself.
//
// The two implementations are intentionally the SAME approach (login-shell
// import unioned with a static fallback set, order-preserving dedupe). Keep
// staticPathDirs below in sync with staticPathDirs() in pathBootstrap.ts.

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// staticPathDirs are common install dirs a minimal ssh PATH omits. Order is
// priority (Homebrew before user-local). MIRRORS staticPathDirs() in
// electron/main/pathBootstrap.ts — keep the two in sync.
func staticPathDirs(home string) []string {
	dirs := []string{
		"/opt/homebrew/bin",
		"/opt/homebrew/sbin",
		"/usr/local/bin",
		"/usr/local/sbin",
	}
	if home != "" {
		dirs = append(dirs, filepath.Join(home, ".local", "bin"))
	}
	return dirs
}

// importLoginShellPath imports the user's real PATH by running their login shell,
// so version managers and custom dirs are picked up and never go stale. Mirrors
// importLoginShellPath() in pathBootstrap.ts: `$SHELL -ilc`, marker-delimited so
// rc/profile banner noise is ignored. Returns "" when it can't be determined.
func importLoginShellPath() string {
	shell := os.Getenv("SHELL")
	if shell == "" {
		return ""
	}
	const mark = "__AC_PATH__"
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, shell, "-ilc", "printf '"+mark+"%s"+mark+"' \"$PATH\"")
	var out bytes.Buffer
	cmd.Stdout = &out
	// stderr is intentionally discarded — interactive shells emit banner noise.
	if err := cmd.Run(); err != nil {
		return ""
	}
	s := out.String()
	i := strings.Index(s, mark)
	if i < 0 {
		return ""
	}
	rest := s[i+len(mark):]
	j := strings.Index(rest, mark)
	if j < 0 {
		return ""
	}
	return strings.TrimSpace(rest[:j])
}

// mergePathDirs joins PATH fragments into one order-preserving, deduped PATH
// string (first occurrence wins; empties dropped). Mirrors mergePathDirs() in
// pathBootstrap.ts.
func mergePathDirs(fragments ...string) string {
	seen := make(map[string]bool)
	var out []string
	for _, frag := range fragments {
		for _, d := range filepath.SplitList(frag) {
			if d == "" || seen[d] {
				continue
			}
			seen[d] = true
			out = append(out, d)
		}
	}
	return strings.Join(out, string(os.PathListSeparator))
}

// bootstrapPath sets the helper process PATH to the login-shell PATH unioned
// with the static fallback dirs and the prior PATH (login-shell wins, then
// fallbacks, then prior). After this, exec.Command("br"/"git") resolves the same
// way it does for a local launch.
func bootstrapPath() {
	home, _ := os.UserHomeDir()
	merged := mergePathDirs(
		importLoginShellPath(),
		strings.Join(staticPathDirs(home), string(os.PathListSeparator)),
		os.Getenv("PATH"),
	)
	if merged != "" {
		_ = os.Setenv("PATH", merged)
	}
}
