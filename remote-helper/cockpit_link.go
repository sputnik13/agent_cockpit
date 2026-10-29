package main

// The helper's `cockpit` CLI link. The multi-call CLI is this very binary
// dispatching on the program name `cockpit` (see cockpit_cli.go), so remote
// hosts need no new provisioning — but provisioning has no symlink primitive and
// only single-level mkdirp, so the HELPER creates, at startup, the directories
// (0700, lstat-verified) and the link:
//
//	~/.agent-cockpit/bin/<os>-<arch>/cockpit  ->  <this helper binary>
//
// It lives in a per-os/arch directory with the link itself named `cockpit`
// because dispatch keys on the program name and an NFS home can be shared between
// hosts of different architectures. The name is fixed and the TARGET is what
// changes: every helper that starts retargets the link at its own executable, so
// the newest launch wins. That target is an immutable build, because provisioning
// keys the uploaded file's name on the build's source hash
// (helper-<version>-<sourceHash12>-<os>-<arch>): another app build, or an older
// one, writes a different file and cannot swap the bytes under the link. The
// envelope's `v` field covers protocol skew between the CLI the link names and a
// listener of another build. The link is replaced atomically (temp link + rename),
// so a pane running the CLI never sees it missing, and re-creating it is
// idempotent. Older helper files are never pruned (see remote-helper/README.md).

import (
	"fmt"
	"os"
	"path/filepath"
)

// cockpitLinkPath is where the CLI link for this host's os/arch lives.
func cockpitLinkPath(home, goos, goarch string) string {
	return filepath.Join(home, ".agent-cockpit", "bin", goos+"-"+goarch, "cockpit")
}

// ensureCockpitLink makes cockpitLinkPath(...) a symlink to exe and returns its
// path. The two directories it needs are created 0700 and verified (a real
// directory owned by uid, no group/other access) or the call fails closed:
// nothing else may be able to swap the link.
func ensureCockpitLink(home, exe, goos, goarch string, uid int) (string, error) {
	if home == "" {
		return "", fmt.Errorf("no home directory")
	}
	if !filepath.IsAbs(exe) {
		return "", fmt.Errorf("helper path %q is not absolute", exe)
	}
	link := cockpitLinkPath(home, goos, goarch)
	archDir := filepath.Dir(link)
	for _, dir := range []string{filepath.Dir(archDir), archDir} {
		if err := preparePrivateDir(dir, uid); err != nil {
			return "", err
		}
	}
	if current, err := os.Readlink(link); err == nil && current == exe {
		return link, nil // already exactly right
	}
	tmp := fmt.Sprintf("%s.tmp-%s", link, randomHex(4))
	if err := os.Symlink(exe, tmp); err != nil {
		return "", fmt.Errorf("create %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, link); err != nil {
		_ = os.Remove(tmp)
		return "", fmt.Errorf("replace %s: %w", link, err)
	}
	return link, nil
}
