package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/local-repo-explorer/cockpit-mux/daemon"
	"github.com/local-repo-explorer/cockpit-mux/protocol"
	"github.com/vmihailenco/msgpack/v5"
	"golang.org/x/sys/unix"
)

func TestOwnerPipeEOFCancelsDaemonContext(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	// contextWithOwner takes ownership of the descriptor, matching the daemon's
	// inherited-fd contract. Pass a duplicate so the original *os.File cannot
	// later finalize a descriptor number that has already been reused by a test
	// listener or socket.
	ownerFD, err := unix.Dup(int(reader.Fd()))
	if err != nil {
		_ = reader.Close()
		_ = writer.Close()
		t.Fatal(err)
	}
	ctx, owner, release, err := contextWithOwner(context.Background(), ownerFD)
	if err != nil {
		_ = reader.Close()
		_ = writer.Close()
		_ = unix.Close(ownerFD)
		t.Fatal(err)
	}
	defer release()
	if err := reader.Close(); err != nil {
		t.Fatal(err)
	}
	if owner == nil {
		t.Fatal("owner descriptor was not retained")
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("owner EOF did not cancel the daemon context")
	}
}

func TestBridgeSocketPreservesFramedBytes(t *testing.T) {
	root, err := os.MkdirTemp("/tmp", "cmux-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	path := filepath.Join(root, "mux.sock")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	done := make(chan error, 1)
	go func() {
		connection, err := listener.AcceptUnix()
		if err != nil {
			done <- err
			return
		}
		defer connection.Close()
		data, err := io.ReadAll(connection)
		if err == nil {
			_, err = connection.Write(data)
		}
		done <- err
	}()
	frame := []byte{0, 0, 0, 3, 0xff, 0, 0x80}
	var output bytes.Buffer
	if err := bridgeSocket(path, bytes.NewReader(frame), &output); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(output.Bytes(), frame) {
		t.Fatalf("bridge output = %x, want %x", output.Bytes(), frame)
	}
}

func TestRunContextRejectsUnboundedScrollbackTarget(t *testing.T) {
	for _, value := range []string{"0", strconv.FormatUint(uint64(daemon.MaxScrollbackLines)+1, 10)} {
		err := runContext(context.Background(), []string{"--scrollback-lines=" + value})
		if err == nil || !strings.Contains(err.Error(), "scrollback-lines must be between") {
			t.Fatalf("scrollback-lines=%s error = %v", value, err)
		}
	}
}

func TestRunVersionDoesNotOpenMuxHome(t *testing.T) {
	previous := SourceHash
	SourceHash = "build-hash"
	t.Cleanup(func() { SourceHash = previous })
	if err := run([]string{"version"}); err != nil {
		t.Fatalf("run version: %v", err)
	}
}

func TestDefaultHomeHonorsCockpitMuxHomeIsolation(t *testing.T) {
	isolation := filepath.Join(t.TempDir(), "isolated-mux")
	t.Setenv("COCKPIT_MUX_HOME", isolation)
	if got := defaultHome(); got != isolation {
		t.Fatalf("default mux home = %q, want isolated %q", got, isolation)
	}
}

func TestRunContextServesIsolatedHome(t *testing.T) {
	root, err := os.MkdirTemp("/tmp", "cmux-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	home := filepath.Join(root, "mux")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runContext(ctx, []string{"--home", home}) }()

	socket := runtimeSocket(home)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Lstat(socket); err == nil {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("daemon exited before creating socket: %v", err)
		default:
		}
		time.Sleep(10 * time.Millisecond)
	}
	if info, err := os.Lstat(socket); err != nil || info.Mode()&os.ModeSocket == 0 {
		t.Fatalf("isolated mux socket not created: info=%v err=%v", info, err)
	}
	cancel()
	if err := <-done; err != nil && !errors.Is(err, context.Canceled) {
		t.Fatalf("daemon shutdown error: %v", err)
	}
}

func TestListMuxSessionsUsesStandaloneProtocolClient(t *testing.T) {
	root, err := os.MkdirTemp("/tmp", "cmux-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	home := filepath.Join(root, "mux")
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	done := make(chan error, 1)
	go func() { done <- runContext(ctx, []string{"--home", home}) }()

	socket := filepath.Join(home, "mux.sock")
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Lstat(socket); err == nil {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("daemon exited before creating socket: %v", err)
		default:
		}
		time.Sleep(10 * time.Millisecond)
	}
	if info, err := os.Lstat(socket); err != nil || info.Mode()&os.ModeSocket == 0 {
		t.Fatalf("mux socket not created: info=%v err=%v", info, err)
	}
	connection, err := net.Dial("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if err := protocol.Write(connection, protocol.Hello{Protocol: protocol.Version}); err != nil {
		t.Fatal(err)
	}
	create, err := msgpack.Marshal(daemon.CreateSessionRequest{Command: "/bin/sh", Args: []string{"-c", "sleep 30"}, Key: "fallback-test"})
	if err != nil {
		t.Fatal(err)
	}
	if err := protocol.Write(connection, protocol.Request{ID: 1, Method: "session.create", Data: create}); err != nil {
		t.Fatal(err)
	}
	var response protocol.Response
	if err := protocol.Read(connection, &response); err != nil {
		t.Fatal(err)
	}
	if response.Error != "" {
		t.Fatalf("session.create error = %s", response.Error)
	}

	var output bytes.Buffer
	if err := listMuxSessions(socket, &output); err != nil {
		select {
		case serveErr := <-done:
			t.Fatalf("standalone list failed after daemon exited: list error=%v, serve error=%v", err, serveErr)
		default:
			info, statErr := os.Lstat(socket)
			t.Fatalf("standalone list failed while daemon was still running: list error=%v, socket info=%v, stat error=%v", err, info, statErr)
		}
	}
	if !bytes.Contains(output.Bytes(), []byte("session-1\tfallback-test\tpane-1\tlive")) {
		t.Fatalf("session list output = %q", output.String())
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("daemon shutdown error: %v", err)
	}
}

func TestTopologyControlCreatesWindowAndSplitThroughDaemonProtocol(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "mux")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runContext(ctx, []string{"--home", home}) }()
	socket := runtimeSocket(home)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Lstat(socket); err == nil {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("daemon exited before creating socket: %v", err)
		default:
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := os.Lstat(socket); err != nil {
		t.Fatalf("mux socket: %v", err)
	}

	client, err := dialMuxSocket(socket)
	if err != nil {
		t.Fatal(err)
	}
	var rootSession daemon.CreateSessionResponse
	if err := client.requestForProject("project-a", "session.create", daemon.CreateSessionRequest{
		Command: "/bin/sh", Args: []string{"-c", "sleep 30"}, Key: "root",
	}, &rootSession); err != nil {
		_ = client.Close()
		t.Fatal(err)
	}
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}

	var windowOutput bytes.Buffer
	if err := runTopologyControl(socket, []string{"window", "new", "--session", rootSession.SessionID, "--", "/bin/sh", "-c", "sleep 30"}, &windowOutput); err != nil {
		t.Fatal(err)
	}
	var window topologyControlResponse
	if err := json.Unmarshal(windowOutput.Bytes(), &window); err != nil {
		t.Fatal(err)
	}
	if window.SessionID == "" || window.PaneID == "" || window.SessionID == rootSession.SessionID {
		t.Fatalf("window control response = %#v", window)
	}

	var splitOutput bytes.Buffer
	if err := runTopologyControl(socket, []string{"pane", "split", "--pane", rootSession.PaneID, "--direction", "vertical", "--", "/bin/sh", "-c", "sleep 30"}, &splitOutput); err != nil {
		t.Fatal(err)
	}
	var split topologyControlResponse
	if err := json.Unmarshal(splitOutput.Bytes(), &split); err != nil {
		t.Fatal(err)
	}
	if split.SessionID == "" || split.PaneID == "" || split.SessionID == rootSession.SessionID {
		t.Fatalf("split control response = %#v", split)
	}

	client, err = dialMuxSocket(socket)
	if err != nil {
		t.Fatal(err)
	}
	var topology daemon.TopologyResponse
	if err := client.requestForProject("project-a", "session.topology", struct{}{}, &topology); err != nil {
		_ = client.Close()
		t.Fatal(err)
	}
	_ = client.Close()
	if len(topology.Sessions) != 1 || len(topology.Sessions[0].Windows) != 2 {
		t.Fatalf("topology after control commands = %#v", topology)
	}
	if len(topology.Sessions[0].Windows[0].Panes) != 2 {
		t.Fatalf("split topology = %#v", topology.Sessions[0].Windows[0])
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("daemon shutdown error: %v", err)
	}
}

func TestMuxLaunchCommandUsesDefaultShellOnlyWhenNoCommandWasProvided(t *testing.T) {
	program, args := muxLaunchCommand(nil)
	if program != "/usr/bin/env" || !slices.Equal(args, []string{"BYOBU_DISABLE=1", "/bin/sh", "-c", `exec "${SHELL:-/bin/sh}"`}) {
		t.Fatalf("default launch = %q %#v", program, args)
	}
	program, args = muxLaunchCommand([]string{"/usr/bin/printf", "hello"})
	if program != "/usr/bin/printf" || !slices.Equal(args, []string{"hello"}) {
		t.Fatalf("explicit launch = %q %#v", program, args)
	}
}

func TestMuxShutdownAcknowledgesBeforeDaemonStops(t *testing.T) {
	root, err := os.MkdirTemp("/tmp", "cmux-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	home := filepath.Join(root, "mux")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runContext(ctx, []string{"--home", home}) }()
	socket := filepath.Join(home, "mux.sock")
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Lstat(socket); err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	connection, err := net.Dial("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if err := protocol.Write(connection, protocol.Hello{Protocol: protocol.Version}); err != nil {
		t.Fatal(err)
	}
	data, err := msgpack.Marshal(struct{}{})
	if err != nil {
		t.Fatal(err)
	}
	if err := protocol.Write(connection, protocol.Request{ID: 1, Method: "mux.shutdown", Data: data}); err != nil {
		t.Fatal(err)
	}
	var response protocol.Response
	if err := protocol.Read(connection, &response); err != nil {
		t.Fatal(err)
	}
	if response.Error != "" {
		t.Fatalf("mux.shutdown error = %s", response.Error)
	}
	if err := <-done; err != nil {
		t.Fatalf("daemon shutdown error: %v", err)
	}
}

func TestDaemonRecordsItsSourceHashInMuxHome(t *testing.T) {
	root, err := os.MkdirTemp("/tmp", "cmux-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	home := filepath.Join(root, "mux")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runContext(ctx, []string{"--home", home}) }()
	socket := filepath.Join(home, "mux.sock")
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Lstat(socket); err == nil {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("daemon exited before creating socket: %v", err)
		default:
		}
		time.Sleep(10 * time.Millisecond)
	}
	if info, err := os.Lstat(socket); err != nil || info.Mode()&os.ModeSocket == 0 {
		t.Fatalf("mux socket not created: info=%v err=%v", info, err)
	}
	data, err := os.ReadFile(filepath.Join(home, "daemon-source-hash"))
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(data)); got != SourceHash {
		t.Fatalf("recorded source hash = %q, want %q", got, SourceHash)
	}
	cancel()
	if err := <-done; err != nil && !errors.Is(err, context.Canceled) {
		t.Fatalf("daemon shutdown error: %v", err)
	}
}

func TestVerifyHandoffChildNacksIncompatibleEngineBeforeOldDaemonReleasesDescriptors(t *testing.T) {
	left, right := verifyHandoffSocketPair(t)
	defer left.Close()
	defer right.Close()
	childDescriptor := duplicateUnixDescriptor(t, right)
	master, err := os.CreateTemp(t.TempDir(), "mux-handoff-master-")
	if err != nil {
		t.Fatal(err)
	}
	defer master.Close()
	manifest := daemon.HandoffManifest{
		Version:       5,
		EngineVersion: "incompatible-engine",
		ListenerIndex: -1,
		Panes: []daemon.HandoffPane{{
			SessionID: "session-1", PaneID: "pane-1", LogicalSessionID: "session-1", WindowID: "window-1",
			MasterIndex: 0, ProcessGroupID: 1234, LeaderStartToken: "Tue Sep 9 12:34:56 2026", Boundary: "grounded", Snapshot: []byte("not reached"), PrimarySnapshot: []byte("not reached"), Metadata: []byte("not reached"),
		}},
		Topology: []daemon.HandoffTopologySession{{SessionID: "session-1", WindowOrder: []string{"window-1"}, Windows: []daemon.HandoffTopologyWindow{{WindowID: "window-1", Layout: &daemon.TopologyLayoutNode{PaneID: "pane-1"}}}}},
	}
	childDone := make(chan error, 1)
	go func() { childDone <- verifyHandoffChild(strconv.Itoa(childDescriptor)) }()
	if err := daemon.SendHandoff(left, manifest, []*os.File{master}); err != nil {
		t.Fatal(err)
	}
	var result daemon.HandoffResult
	if err := protocol.Read(left, &result); err != nil {
		t.Fatal(err)
	}
	if result.Accepted || !strings.Contains(result.Error, expectedHandoffVerifierError()) {
		t.Fatalf("handoff result = %#v", result)
	}
	if err := <-childDone; err == nil || !strings.Contains(err.Error(), "mux handoff rejected") {
		t.Fatalf("handoff child error = %v", err)
	}
}

func verifyHandoffSocketPair(t *testing.T) (*net.UnixConn, *net.UnixConn) {
	t.Helper()
	descriptors, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_STREAM, 0)
	if err != nil {
		t.Fatal(err)
	}
	leftFile := os.NewFile(uintptr(descriptors[0]), "mux-verify-left")
	rightFile := os.NewFile(uintptr(descriptors[1]), "mux-verify-right")
	leftConnection, err := net.FileConn(leftFile)
	_ = leftFile.Close()
	if err != nil {
		_ = rightFile.Close()
		t.Fatal(err)
	}
	rightConnection, err := net.FileConn(rightFile)
	_ = rightFile.Close()
	if err != nil {
		_ = leftConnection.Close()
		t.Fatal(err)
	}
	left, ok := leftConnection.(*net.UnixConn)
	if !ok {
		_ = leftConnection.Close()
		_ = rightConnection.Close()
		t.Fatal("left handoff socket is not Unix")
	}
	right, ok := rightConnection.(*net.UnixConn)
	if !ok {
		_ = leftConnection.Close()
		_ = rightConnection.Close()
		t.Fatal("right handoff socket is not Unix")
	}
	return left, right
}

func duplicateUnixDescriptor(t *testing.T, connection *net.UnixConn) int {
	t.Helper()
	raw, err := connection.SyscallConn()
	if err != nil {
		t.Fatal(err)
	}
	var duplicated int
	if err := raw.Control(func(fd uintptr) { duplicated, err = unix.Dup(int(fd)) }); err != nil {
		t.Fatal(err)
	}
	if err != nil {
		t.Fatal(err)
	}
	return duplicated
}

func TestSelectLiveSession(t *testing.T) {
	sessions := []daemon.SessionListItem{
		{SessionID: "session-dead", Exited: true},
		{SessionID: "session-1", PaneID: "pane-1"},
	}
	selected, err := selectLiveSession(sessions, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if selected.SessionID != "session-1" {
		t.Fatalf("selected %q, want session-1", selected.SessionID)
	}
	if _, err := selectLiveSession(sessions, "session-dead", ""); err == nil {
		t.Fatal("selecting exited session unexpectedly succeeded")
	}
	if _, err := selectLiveSession([]daemon.SessionListItem{{SessionID: "session-1"}, {SessionID: "session-2"}}, "", ""); err == nil {
		t.Fatal("ambiguous attach unexpectedly succeeded")
	}
	selected, err = selectLiveSession(sessions, "", "pane-1")
	if err != nil || selected.SessionID != "session-1" {
		t.Fatalf("selected pane = %#v, err=%v", selected, err)
	}
	if _, err := selectLiveSession(sessions, "session-1", "pane-other"); err == nil {
		t.Fatal("mismatched requested pane unexpectedly selected a session")
	}
}

func TestSplitDetachChordPreservesInputAndRecognizesCtrlBD(t *testing.T) {
	pending := false
	forwarded, detach := splitDetachChord([]byte("vim"), &pending)
	if detach || pending || !bytes.Equal(forwarded, []byte("vim")) {
		t.Fatalf("ordinary input = %q detach=%v pending=%v", forwarded, detach, pending)
	}
	forwarded, detach = splitDetachChord([]byte{0x02}, &pending)
	if detach || !pending || len(forwarded) != 0 {
		t.Fatalf("Ctrl-B prefix = %q detach=%v pending=%v", forwarded, detach, pending)
	}
	forwarded, detach = splitDetachChord([]byte("x"), &pending)
	if detach || pending || !bytes.Equal(forwarded, []byte{0x02, 'x'}) {
		t.Fatalf("non-detach Ctrl-B sequence = %q detach=%v pending=%v", forwarded, detach, pending)
	}
	forwarded, detach = splitDetachChord([]byte{0x02, 'd'}, &pending)
	if !detach || pending || len(forwarded) != 0 {
		t.Fatalf("detach chord = %q detach=%v pending=%v", forwarded, detach, pending)
	}
}

func TestAttachRejectsNonTTYInputBeforeConnecting(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()
	if err := attachMuxSession("/missing/mux.sock", "", "", reader, io.Discard); err == nil || err.Error() != "attach requires a TTY on standard input" {
		t.Fatalf("attach non-TTY error = %v", err)
	}
}
