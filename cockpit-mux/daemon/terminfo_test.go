package daemon

import (
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestConfigureTerminfoInstallsBothPlatformDirectoryShapes(t *testing.T) {
	home, err := OpenHome(filepath.Join(t.TempDir(), "mux"))
	if err != nil {
		t.Fatal(err)
	}
	directory, err := ConfigureTerminfo(home)
	if err != nil {
		t.Fatal(err)
	}
	for _, relative := range []string{
		filepath.Join("78", terminalIdentity), filepath.Join("x", terminalIdentity),
		filepath.Join("67", "ghostty"), filepath.Join("g", "ghostty"),
	} {
		info, statErr := os.Stat(filepath.Join(directory, relative))
		if statErr != nil {
			t.Fatalf("terminfo %s: %v", relative, statErr)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("terminfo %s permissions = %o, want 600", relative, info.Mode().Perm())
		}
	}
	command := exec.Command("infocmp", terminalIdentity)
	command.Env = append(os.Environ(), "TERMINFO="+directory)
	output, err := command.CombinedOutput()
	if err != nil || !strings.Contains(string(output), terminalIdentity) {
		t.Fatalf("infocmp output = %q, error = %v", output, err)
	}
	pane, err := StartPane("/bin/sh", "-c", "printf 'TERM=%s\\n' \"$TERM\"; infocmp \"$TERM\"")
	if err != nil {
		t.Fatal(err)
	}
	data, readErr := io.ReadAll(pane.master)
	_ = pane.Close()
	if readErr != nil || !strings.Contains(string(data), "TERM="+terminalIdentity) || !strings.Contains(string(data), terminalIdentity) {
		t.Fatalf("mux PTY terminfo output = %q, error = %v", data, readErr)
	}
}
