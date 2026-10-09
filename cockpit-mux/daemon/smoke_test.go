//go:build libghostty

package daemon

import (
	"bytes"
	"io"
	"os/exec"
	"testing"
	"time"
)

// TestSmokeLocalTUIReattach runs the two locally installed full-screen programs
// named by M1A through a real PTY and fresh Ghostty consumer. It is intentionally
// self-skipping on hosts that do not have the optional developer tools; the regular
// deterministic fixture remains the portable acceptance test.
func TestSmokeLocalTUIReattach(t *testing.T) {
	tests := []struct {
		name    string
		binary  string
		command string
		args    []string
	}{
		{
			name:    "neovim",
			binary:  "nvim",
			command: "NVIM_LOG_FILE=/dev/null nvim --clean -u NONE & child=$!; sleep 0.5; kill -TERM \"$child\"; wait \"$child\" || true",
		},
		{
			name:    "btop",
			binary:  "btop",
			command: "btop & child=$!; sleep 0.5; kill -TERM \"$child\"; wait \"$child\" || true",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := exec.LookPath(test.binary); err != nil {
				t.Skipf("%s is not installed: %v", test.binary, err)
			}
			var pane *Pane
			var err error
			if test.command != "" {
				pane, err = StartPane("/bin/sh", "-c", test.command)
			} else {
				pane, err = StartPane(test.binary, test.args...)
			}
			if err != nil {
				t.Fatal(err)
			}
			defer pane.Close()
			shadow, err := NewShadow(80, 24)
			if err != nil {
				t.Fatal(err)
			}
			defer shadow.Close()
			pipeline := Pipeline{Pane: pane, Shadow: shadow}

			buffer := make([]byte, 32*1024)
			pumpDone := make(chan error, 1)
			go func() {
				for {
					_, readErr := pipeline.Pump(buffer)
					if readErr == io.EOF {
						pumpDone <- nil
						return
					}
					if readErr != nil {
						pumpDone <- readErr
						return
					}
				}
			}()
			deadline := time.Now().Add(2 * time.Second)
			for len(pipeline.Stream.OutputsFrom(1)) == 0 && time.Now().Before(deadline) {
				time.Sleep(10 * time.Millisecond)
			}
			if len(pipeline.Stream.OutputsFrom(1)) == 0 {
				t.Fatal("full-screen program produced no PTY output")
			}

			// Attach while the TUI is still alive. Any chunk produced while the
			// seed holds Stream's lock is delivered after ResumeSequence.
			seed, err := pipeline.Attach(100, 32, 0, 0)
			if err != nil {
				t.Fatal(err)
			}
			if seed.ResumeSequence == 0 || len(seed.Data) == 0 {
				t.Fatalf("invalid reattach seed: %#v", seed)
			}
			consumer, err := NewShadow(100, 32)
			if err != nil {
				t.Fatal(err)
			}
			defer consumer.Close()
			consumer.Feed(seed.Data)
			if err := <-pumpDone; err != nil {
				t.Fatalf("pump %s: %v", test.name, err)
			}
			for _, output := range pipeline.Stream.OutputsFrom(seed.ResumeSequence) {
				consumer.Feed(output.Data)
			}
			got, err := consumer.Seed()
			if err != nil {
				t.Fatal(err)
			}
			want, err := shadow.Seed()
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got, want) {
				t.Fatalf("fresh %s reattach state differs from authoritative shadow", test.name)
			}
		})
	}
}
