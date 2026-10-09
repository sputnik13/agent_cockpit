//go:build libghostty

package main

import (
	"bytes"
	"context"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/local-repo-explorer/cockpit-mux/daemon"
	"github.com/local-repo-explorer/cockpit-mux/protocol"
	"github.com/vmihailenco/msgpack/v5"
)

// TestLiveHandoffRetainsSocketAndPane exercises the real parent/child process
// boundary. The replacement daemon must acknowledge only after it has imported
// the paused PTY, and the same private socket must serve the retained session.
func TestLiveHandoffRetainsSocketAndPane(t *testing.T) {
	root, err := os.MkdirTemp("/tmp", "cmux-live-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	binary := filepath.Join(root, "cockpit-mux-parent")
	build := exec.Command("go", "build", "-tags", "libghostty", "-ldflags", "-X main.SourceHash=parent", "-o", binary, ".")
	build.Dir = "."
	build.Env = os.Environ()
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build handoff fixture: %v\n%s", err, output)
	}
	replacement := filepath.Join(root, "cockpit-mux-replacement")
	build = exec.Command("go", "build", "-tags", "libghostty", "-ldflags", "-X main.SourceHash=replacement", "-o", replacement, ".")
	build.Dir = "."
	build.Env = os.Environ()
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build replacement fixture: %v\n%s", err, output)
	}
	home := filepath.Join(root, "mux")
	parent := exec.Command(binary, "--home", home)
	var parentOutput bytes.Buffer
	parent.Stdout = &parentOutput
	parent.Stderr = &parentOutput
	if err := parent.Start(); err != nil {
		t.Fatal(err)
	}
	parentDone := make(chan error, 1)
	go func() { parentDone <- parent.Wait() }()
	parentWaited := false
	t.Cleanup(func() {
		if !parentWaited && parent.Process != nil {
			_ = parent.Process.Kill()
			_ = parent.Wait()
		}
	})
	socket := filepath.Join(home, "mux.sock")
	waitForMuxSocketOrExit(t, socket, parentDone, &parentOutput)
	create, err := msgpack.Marshal(daemon.CreateSessionRequest{Command: "/bin/sh", Args: []string{"-c", "trap '' HUP; while IFS= read -r line; do printf 'handoff:%s\\n' \"$line\"; done"}, Key: "handoff-live"})
	if err != nil {
		t.Fatal(err)
	}
	var created daemon.CreateSessionResponse
	requestMux(t, socket, "session.create", create, &created)
	if created.SessionID == "" || created.PaneID == "" {
		t.Fatalf("created session = %#v", created)
	}
	upgrade, err := msgpack.Marshal(muxUpgradeRequest{BinaryPath: replacement, SourceHash: "replacement"})
	if err != nil {
		t.Fatal(err)
	}
	requestMux(t, socket, "mux.upgrade", upgrade, &struct{}{})
	if err := <-parentDone; err != nil {
		t.Fatalf("old daemon exit after handoff: %v", err)
	}
	parentWaited = true
	waitForMuxSocket(t, socket)
	if recorded, err := os.ReadFile(filepath.Join(home, "daemon-source-hash")); err != nil || strings.TrimSpace(string(recorded)) != "replacement" {
		t.Fatalf("replacement daemon source hash = %q, err=%v", recorded, err)
	}
	var listed daemon.ListSessionsResponse
	requestMux(t, socket, "session.list", nil, &listed)
	if len(listed.Sessions) != 1 || listed.Sessions[0].SessionID != created.SessionID || listed.Sessions[0].PaneID != created.PaneID {
		t.Fatalf("handoff session inventory = %#v", listed.Sessions)
	}
	write, err := msgpack.Marshal(daemon.WritePaneRequest{PaneID: created.PaneID, Data: []byte("after-handoff\n"), Kind: "input"})
	if err != nil {
		t.Fatal(err)
	}
	requestMux(t, socket, "pane.write", write, &daemon.WritePaneResponse{})
	awaitMuxOutput(t, socket, created.PaneID, []byte("handoff:after-handoff"))
	destroy, err := msgpack.Marshal(daemon.DestroySessionRequest{SessionID: created.SessionID})
	if err != nil {
		t.Fatal(err)
	}
	requestMux(t, socket, "session.destroy", destroy, &daemon.DestroySessionResponse{})
	shutdown, err := msgpack.Marshal(struct{}{})
	if err != nil {
		t.Fatal(err)
	}
	requestMux(t, socket, "mux.shutdown", shutdown, &struct{}{})
	waitForMuxSocketGone(t, socket)
}

func TestLiveHandoffFailuresLeaveOldDaemonServing(t *testing.T) {
	for _, scenario := range []struct {
		name      string
		childMode string
		want      string
		minimum   time.Duration
	}{
		{name: "replacement-nack", childMode: "nack", want: "incompatible mux handoff engine"},
		{name: "replacement-eof", childMode: "eof", want: "read mux handoff result"},
		{name: "replacement-timeout", childMode: "hang", want: "read mux handoff result", minimum: handoffBudget - 250*time.Millisecond},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			testLiveHandoffFailureLeavesOldDaemonServing(t, scenario.childMode, scenario.want, scenario.minimum)
		})
	}
}

func testLiveHandoffFailureLeavesOldDaemonServing(t *testing.T, childMode, want string, minimum time.Duration) {
	t.Helper()
	root, err := os.MkdirTemp("/tmp", "cmux-live-nack-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	home, err := daemon.OpenHome(filepath.Join(root, "mux"))
	if err != nil {
		t.Fatal(err)
	}
	operations := daemon.NewPersistentOperationsWithOptions(home, daemon.PersistentOptions{PersistScrollback: true})
	defer operations.Close()
	target := filepath.Join(root, "cockpit-mux")
	build := exec.Command("go", "build", "-tags", "libghostty", "-o", target, ".")
	build.Dir = "."
	build.Env = os.Environ()
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build handoff target: %v\n%s", err, output)
	}
	server, err := daemon.Listen(home)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()

	previous := newHandoffChildCommand
	newHandoffChildCommand = func(_ string, _ string, _ bool, _ uint, childFile, _ *os.File) *exec.Cmd {
		command := exec.Command(os.Args[0], "-test.run=^TestHandoffFailureChild$", "--")
		command.Env = append(os.Environ(), "COCKPIT_MUX_TEST_HANDOFF_FAILURE="+childMode)
		command.ExtraFiles = []*os.File{childFile}
		return command
	}
	t.Cleanup(func() { newHandoffChildCommand = previous })

	serveContext, cancel := context.WithCancel(context.Background())
	defer cancel()
	serveDone := make(chan error, 1)
	go func() {
		serveDone <- server.Serve(serveContext, func(requestContext context.Context, request protocol.Request) ([]byte, error) {
			if request.Method == "mux.upgrade" {
				var input muxUpgradeRequest
				if err := msgpack.Unmarshal(request.Data, &input); err != nil {
					return nil, err
				}
				return upgradeMux(requestContext, home, server, operations, input, nil)
			}
			return operations.Handle(requestContext, request)
		})
	}()

	socket := filepath.Join(home.Path, "mux.sock")
	waitForMuxSocket(t, socket)
	create, err := msgpack.Marshal(daemon.CreateSessionRequest{
		Command: "/bin/sh", Args: []string{"-c", "while IFS= read -r line; do printf 'still-serving:%s\\n' \"$line\"; done"}, Key: "handoff-nack",
	})
	if err != nil {
		t.Fatal(err)
	}
	var created daemon.CreateSessionResponse
	requestMux(t, socket, "session.create", create, &created)

	upgrade, err := msgpack.Marshal(muxUpgradeRequest{BinaryPath: target, SourceHash: "dev"})
	if err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	if err := requestMuxError(socket, "mux.upgrade", upgrade); err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("handoff rejection = %v", err)
	}
	if minimum > 0 && time.Since(started) < minimum {
		t.Fatalf("handoff timeout returned after %s, want at least %s", time.Since(started), minimum)
	}

	write, err := msgpack.Marshal(daemon.WritePaneRequest{PaneID: created.PaneID, Data: []byte("after-nack\n"), Kind: "input"})
	if err != nil {
		t.Fatal(err)
	}
	requestMux(t, socket, "pane.write", write, &daemon.WritePaneResponse{})
	awaitMuxOutput(t, socket, created.PaneID, []byte("still-serving:after-nack"))

	destroy, err := msgpack.Marshal(daemon.DestroySessionRequest{SessionID: created.SessionID})
	if err != nil {
		t.Fatal(err)
	}
	requestMux(t, socket, "session.destroy", destroy, &daemon.DestroySessionResponse{})
	cancel()
	if err := <-serveDone; err != nil && !errors.Is(err, context.Canceled) {
		t.Fatalf("old daemon shutdown: %v", err)
	}
}

// TestHandoffFailureChild is the replacement process used only by the live
// handoff failure test. It accepts the descriptors, then NACKs, exits, or
// deliberately withholds a response to exercise every parent recovery path.
func TestHandoffFailureChild(t *testing.T) {
	mode := os.Getenv("COCKPIT_MUX_TEST_HANDOFF_FAILURE")
	if mode == "" {
		return
	}
	connection, err := inheritedHandoffConnection("3")
	if err != nil {
		os.Exit(2)
	}
	defer connection.Close()
	_, descriptors, err := daemon.ReceiveHandoff(connection)
	for _, descriptor := range descriptors {
		_ = descriptor.Close()
	}
	if err != nil {
		os.Exit(3)
	}
	switch mode {
	case "nack":
		if err := protocol.Write(connection, daemon.HandoffResult{Accepted: false, Error: "incompatible mux handoff engine"}); err != nil {
			os.Exit(4)
		}
		os.Exit(0)
	case "eof":
		return
	case "hang":
		select {}
	default:
		os.Exit(5)
	}
}

func awaitMuxOutput(t *testing.T, socket, paneID string, needle []byte) {
	awaitMuxOutputForProject(t, socket, "", paneID, needle)
}

func awaitMuxOutputForProject(t *testing.T, socket, projectID, paneID string, needle []byte) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		data, err := msgpack.Marshal(daemon.ReadPaneOutputRequest{PaneID: paneID, FromSequence: 1})
		if err != nil {
			t.Fatal(err)
		}
		var output daemon.ReadPaneOutputResponse
		requestMuxProject(t, socket, projectID, "pane.output", data, &output)
		var combined []byte
		for _, chunk := range output.Outputs {
			combined = append(combined, chunk.Data...)
		}
		if bytes.Contains(combined, needle) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for post-handoff output %q", needle)
}

func waitForMuxSocket(t *testing.T, socket string) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if info, err := os.Lstat(socket); err == nil && info.Mode()&os.ModeSocket != 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("mux socket was not available: %s", socket)
}

func waitForMuxSocketGone(t *testing.T, socket string) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Lstat(socket); errors.Is(err, os.ErrNotExist) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("mux socket was not removed after shutdown: %s", socket)
}

func waitForMuxSocketOrExit(t *testing.T, socket string, done <-chan error, output *bytes.Buffer) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if info, err := os.Lstat(socket); err == nil && info.Mode()&os.ModeSocket != 0 {
			return
		}
		select {
		case err := <-done:
			t.Fatalf("mux daemon exited before opening socket: %v\n%s", err, output.String())
		default:
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("mux socket was not available: %s\n%s", socket, output.String())
}

func requestMux(t *testing.T, socket, method string, data []byte, output any) {
	requestMuxProject(t, socket, "", method, data, output)
}

func requestMuxProject(t *testing.T, socket, projectID, method string, data []byte, output any) {
	t.Helper()
	context, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	dialer := net.Dialer{}
	connection, err := dialer.DialContext(context, "unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if err := protocol.Write(connection, protocol.Hello{Protocol: protocol.Version}); err != nil {
		t.Fatal(err)
	}
	if err := protocol.Write(connection, protocol.Request{ID: 1, Method: method, ProjectID: projectID, Data: data}); err != nil {
		t.Fatal(err)
	}
	if err := connection.SetDeadline(time.Now().Add(15 * time.Second)); err != nil {
		t.Fatal(err)
	}
	var response protocol.Response
	if err := protocol.Read(connection, &response); err != nil {
		t.Fatal(err)
	}
	if response.Error != "" {
		t.Fatalf("%s error: %s", method, response.Error)
	}
	if err := msgpack.Unmarshal(response.Data, output); err != nil {
		t.Fatalf("decode %s: %v", method, err)
	}
}

func requestMuxError(socket, method string, data []byte) error {
	context, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	connection, err := (&net.Dialer{}).DialContext(context, "unix", socket)
	if err != nil {
		return err
	}
	defer connection.Close()
	if err := protocol.Write(connection, protocol.Hello{Protocol: protocol.Version}); err != nil {
		return err
	}
	if err := protocol.Write(connection, protocol.Request{ID: 1, Method: method, Data: data}); err != nil {
		return err
	}
	if err := connection.SetDeadline(time.Now().Add(15 * time.Second)); err != nil {
		return err
	}
	var response protocol.Response
	if err := protocol.Read(connection, &response); err != nil {
		return err
	}
	if response.Error == "" {
		return nil
	}
	return errors.New(response.Error)
}
