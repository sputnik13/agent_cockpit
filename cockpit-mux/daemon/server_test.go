package daemon

import (
	"bytes"
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/local-repo-explorer/cockpit-mux/protocol"
)

func TestServerRequiresCompatibleHelloBeforeRequestSideEffect(t *testing.T) {
	var calls atomic.Uint64
	home, stop := startTestServer(t, func(_ context.Context, _ protocol.Request) ([]byte, error) {
		calls.Add(1)
		return nil, nil
	})
	defer stop()

	connection := dialTestClient(t, home)
	defer connection.Close()
	if err := protocol.Write(connection, protocol.Hello{Protocol: protocol.Version + 1}); err != nil {
		t.Fatal(err)
	}
	var response protocol.Response
	if err := protocol.Read(connection, &response); err != nil {
		t.Fatal(err)
	}
	if response.ID != 0 || !strings.Contains(response.Error, protocol.ErrVersionMismatch.Error()) {
		t.Fatalf("protocol mismatch response = %#v", response)
	}
	awaitConnectionClose(t, connection)
	if got := calls.Load(); got != 0 {
		t.Fatalf("handler calls = %d, want 0 for protocol mismatch", got)
	}
}

func TestServerCorrelatesResponseWithRequest(t *testing.T) {
	home, stop := startTestServer(t, func(_ context.Context, request protocol.Request) ([]byte, error) {
		return append([]byte("ack:"), request.Data...), nil
	})
	defer stop()

	connection := dialTestClient(t, home)
	defer connection.Close()
	writeHello(t, connection)
	request := protocol.Request{ID: 41, Method: "pane.write", Data: []byte{0x00, 0xff, 'x'}}
	if err := protocol.Write(connection, request); err != nil {
		t.Fatal(err)
	}

	var response protocol.Response
	if err := protocol.Read(connection, &response); err != nil {
		t.Fatal(err)
	}
	if response.ID != request.ID {
		t.Fatalf("response ID = %d, want %d", response.ID, request.ID)
	}
	if !bytes.Equal(response.Data, append([]byte("ack:"), request.Data...)) {
		t.Fatalf("response data = %x, want binary payload preserved", response.Data)
	}
	if response.Error != "" {
		t.Fatalf("response error = %q", response.Error)
	}
}

func TestServerClosesMalformedRequestWithoutHandler(t *testing.T) {
	var calls atomic.Uint64
	home, stop := startTestServer(t, func(_ context.Context, _ protocol.Request) ([]byte, error) {
		calls.Add(1)
		return nil, nil
	})
	defer stop()

	connection := dialTestClient(t, home)
	defer connection.Close()
	writeHello(t, connection)
	if err := protocol.Write(connection, map[string]any{"id": "not-an-integer", "method": "pane.write"}); err != nil {
		t.Fatal(err)
	}
	awaitConnectionClose(t, connection)
	if got := calls.Load(); got != 0 {
		t.Fatalf("handler calls = %d, want 0 for malformed request", got)
	}
}

func TestServerRejectsCredentialMismatchBeforeHelloOrHandler(t *testing.T) {
	var calls atomic.Uint64
	home, stop := startTestServerWithPeerUID(t, func(_ context.Context, _ protocol.Request) ([]byte, error) {
		calls.Add(1)
		return nil, nil
	}, func(*net.UnixConn) (uint32, error) {
		return uint32(os.Getuid() + 1), nil
	})
	defer stop()

	connection := dialTestClient(t, home)
	defer connection.Close()
	awaitConnectionClose(t, connection)
	if got := calls.Load(); got != 0 {
		t.Fatalf("handler calls = %d, want 0 for credential mismatch", got)
	}
}

func TestClientDisconnectDoesNotStopServer(t *testing.T) {
	home, stop := startTestServer(t, func(_ context.Context, request protocol.Request) ([]byte, error) {
		return []byte(request.Method), nil
	})
	defer stop()

	disconnected := dialTestClient(t, home)
	writeHello(t, disconnected)
	disconnected.Close()

	connection := dialTestClient(t, home)
	defer connection.Close()
	writeHello(t, connection)
	if err := protocol.Write(connection, protocol.Request{ID: 7, Method: "pane.attach"}); err != nil {
		t.Fatal(err)
	}
	var response protocol.Response
	if err := protocol.Read(connection, &response); err != nil {
		t.Fatalf("server did not survive prior client disconnect: %v", err)
	}
	if response.ID != 7 || string(response.Data) != "pane.attach" {
		t.Fatalf("response = %+v, want correlated pane.attach response", response)
	}
}

func TestServerNotifiesAndClosesDisplacedAttachClient(t *testing.T) {
	home, stop := startTestServer(t, func(_ context.Context, _ protocol.Request) ([]byte, error) { return nil, nil })
	defer stop()
	first := dialTestClient(t, home)
	defer first.Close()
	writeHello(t, first)
	if err := protocol.Write(first, operationRequest(t, 1, methodSessionAttach, AttachSessionRequest{SessionID: "session-1", ClientID: "cockpit-a", ClientKind: "cockpit", Cols: 80, Rows: 24})); err != nil {
		t.Fatal(err)
	}
	var response protocol.Response
	if err := protocol.Read(first, &response); err != nil {
		t.Fatal(err)
	}
	second := dialTestClient(t, home)
	defer second.Close()
	writeHello(t, second)
	if err := protocol.Write(second, operationRequest(t, 2, methodSessionAttach, AttachSessionRequest{SessionID: "session-1", ClientID: "tty-b", ClientKind: "tty", Cols: 100, Rows: 30})); err != nil {
		t.Fatal(err)
	}
	if err := protocol.Read(second, &response); err != nil {
		t.Fatal(err)
	}
	var event protocol.Event
	if err := protocol.Read(first, &event); err != nil {
		t.Fatal(err)
	}
	if event.Event != "session.stolen" || event.SessionID != "session-1" || event.ByKind != "tty" {
		t.Fatalf("stolen event = %#v", event)
	}
	awaitConnectionClose(t, first)
}

func TestServerReattachAndDisconnectMaintainExclusiveOwnership(t *testing.T) {
	operations := NewOperations()
	home, stop := startTestServer(t, operations.Handle)
	defer stop()

	created := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh", Args: []string{"-c", "sleep 30"},
	})
	var session CreateSessionResponse
	decodeResponse(t, created, &session)
	defer requestOperation(t, operations, 99, methodSessionDestroy, DestroySessionRequest{SessionID: session.SessionID})

	first := dialTestClient(t, home)
	writeHello(t, first)
	firstAttach := AttachSessionRequest{SessionID: session.SessionID, ClientID: "cockpit-a", ClientKind: "cockpit", Cols: 80, Rows: 24}
	writeOperation(t, first, 2, methodSessionAttach, firstAttach)
	var response protocol.Response
	readOperationResponse(t, first, &response)
	var attached AttachSessionResponse
	decodeResponse(t, response.Data, &attached)
	if attached.Stole {
		t.Fatal("initial attach unexpectedly reported a steal")
	}

	firstAttach.Cols = 100
	firstAttach.Rows = 30
	writeOperation(t, first, 3, methodSessionAttach, firstAttach)
	readOperationResponse(t, first, &response)
	decodeResponse(t, response.Data, &attached)
	if attached.Stole {
		t.Fatal("same-connection reattach unexpectedly reported a steal")
	}

	second := dialTestClient(t, home)
	writeHello(t, second)
	writeOperation(t, second, 4, methodSessionAttach, AttachSessionRequest{SessionID: session.SessionID, ClientID: "tty-b", ClientKind: "tty", Cols: 100, Rows: 30})
	readOperationResponse(t, second, &response)
	decodeResponse(t, response.Data, &attached)
	if !attached.Stole {
		t.Fatal("replacement connection did not report a steal")
	}
	var event protocol.Event
	if err := protocol.Read(first, &event); err != nil {
		t.Fatalf("read displaced event: %v", err)
	}
	if event.Event != "session.stolen" || event.SessionID != session.SessionID || event.ByKind != "tty" {
		t.Fatalf("stolen event = %#v", event)
	}
	awaitConnectionClose(t, first)

	second.Close()
	inspector := dialTestClient(t, home)
	defer inspector.Close()
	writeHello(t, inspector)
	deadline := time.Now().Add(2 * time.Second)
	for requestID := uint64(5); ; requestID++ {
		writeOperation(t, inspector, requestID, methodSessionList, struct{}{})
		readOperationResponse(t, inspector, &response)
		var listed ListSessionsResponse
		decodeResponse(t, response.Data, &listed)
		if len(listed.Sessions) == 1 && listed.Sessions[0].AttachedKind == "" {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("client close left session attached: %#v", listed.Sessions)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestAdoptedListenerKeepsTheLiveSocketPath(t *testing.T) {
	root, err := os.MkdirTemp("/tmp", "cmux-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)
	home, err := OpenHome(filepath.Join(root, "mux"))
	if err != nil {
		t.Fatal(err)
	}
	original, err := Listen(home)
	if err != nil {
		t.Fatal(err)
	}
	file, err := original.ListenerFile()
	if err != nil {
		_ = original.Close()
		t.Fatal(err)
	}
	defer file.Close()
	listener, err := net.FileListener(file)
	if err != nil {
		_ = original.Close()
		t.Fatal(err)
	}
	unixListener, ok := listener.(*net.UnixListener)
	if !ok {
		_ = listener.Close()
		_ = original.Close()
		t.Fatal("duplicated listener is not Unix")
	}
	adopted, err := AdoptListener(unixListener)
	if err != nil {
		_ = listener.Close()
		_ = original.Close()
		t.Fatal(err)
	}
	if err := original.CloseForHandoff(); err != nil {
		_ = adopted.Close()
		t.Fatal(err)
	}
	if info, err := os.Lstat(home.SocketPath); err != nil || info.Mode()&os.ModeSocket == 0 {
		_ = adopted.Close()
		t.Fatalf("handoff socket path disappeared: info=%v err=%v", info, err)
	}
	if err := adopted.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(home.SocketPath); err != nil {
		t.Fatalf("adopted close removed handoff socket path: %v", err)
	}
}

func TestServerCorrelatesConcurrentClientsIndependently(t *testing.T) {
	home, stop := startTestServer(t, func(_ context.Context, request protocol.Request) ([]byte, error) {
		return []byte(request.Method), nil
	})
	defer stop()

	results := make(chan protocol.Response, 2)
	errors := make(chan error, 2)
	for _, request := range []protocol.Request{
		{ID: 101, Method: "pane.write"},
		{ID: 202, Method: "session.attach"},
	} {
		request := request
		go func() {
			connection := dialTestClient(t, home)
			defer connection.Close()
			writeHello(t, connection)
			if err := protocol.Write(connection, request); err != nil {
				errors <- err
				return
			}
			var response protocol.Response
			if err := protocol.Read(connection, &response); err != nil {
				errors <- err
				return
			}
			results <- response
		}()
	}

	seen := make(map[uint64]string)
	for range 2 {
		select {
		case err := <-errors:
			t.Fatal(err)
		case response := <-results:
			seen[response.ID] = string(response.Data)
		case <-time.After(time.Second):
			t.Fatal("timed out waiting for concurrent mux clients")
		}
	}
	if seen[101] != "pane.write" || seen[202] != "session.attach" {
		t.Fatalf("concurrent responses = %#v", seen)
	}
}

func startTestServer(t *testing.T, handler RequestHandler) (Home, func()) {
	t.Helper()
	return startTestServerWithPeerUID(t, handler, nil)
}

func startTestServerWithPeerUID(t *testing.T, handler RequestHandler, peerUID peerUIDReader) (Home, func()) {
	t.Helper()
	root, err := os.MkdirTemp("/tmp", "cmux-")
	if err != nil {
		t.Fatal(err)
	}
	home, err := OpenHome(filepath.Join(root, "mux"))
	if err != nil {
		os.RemoveAll(root)
		t.Fatal(err)
	}
	server, err := Listen(home)
	if err != nil {
		os.RemoveAll(root)
		t.Fatal(err)
	}
	if peerUID != nil {
		server.peerUID = peerUID
	}
	info, err := os.Stat(home.SocketPath)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("socket permissions = %#o, want 0600", got)
	}

	ctx, cancel := context.WithCancel(context.Background())
	serveDone := make(chan error, 1)
	go func() { serveDone <- server.Serve(ctx, handler) }()
	return home, func() {
		cancel()
		if err := server.Close(); err != nil {
			t.Errorf("Close() error = %v", err)
		}
		if err := <-serveDone; err != nil {
			t.Errorf("Serve() error = %v", err)
		}
		if err := os.RemoveAll(root); err != nil {
			t.Errorf("remove test home: %v", err)
		}
	}
}

func dialTestClient(t *testing.T, home Home) *net.UnixConn {
	t.Helper()
	connection, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: home.SocketPath, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	return connection
}

func writeHello(t *testing.T, connection *net.UnixConn) {
	t.Helper()
	if err := protocol.Write(connection, protocol.Hello{Protocol: protocol.Version}); err != nil {
		t.Fatal(err)
	}
}

func awaitConnectionClose(t *testing.T, connection *net.UnixConn) {
	t.Helper()
	if err := connection.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	defer connection.SetReadDeadline(time.Time{})
	var response protocol.Response
	err := protocol.Read(connection, &response)
	if err == nil {
		t.Fatalf("malformed client unexpectedly received response: %+v", response)
	}
	if errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("server did not close malformed client: %v", err)
	}
}
