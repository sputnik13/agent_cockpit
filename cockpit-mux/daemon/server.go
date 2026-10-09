package daemon

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"sync"

	"github.com/local-repo-explorer/cockpit-mux/protocol"
	"github.com/vmihailenco/msgpack/v5"
)

// Server accepts local mux clients. The only accepted pre-request frame is Hello,
// so incompatible clients cannot issue a state-changing request.
type Server struct {
	listener      *net.UnixListener
	peerUID       peerUIDReader
	uid           uint32
	removeSocket  bool
	afterResponse func(protocol.Request)

	closeOnce   sync.Once
	stopOnce    sync.Once
	stopping    chan struct{}
	lifecycleMu sync.Mutex
	serving     bool
	ownerMu     sync.Mutex
	owners      map[string]connectionOwner
}

type connectionOwner struct {
	connection *net.UnixConn
	clientID   string
	clientKind string
	projectID  string
}

type detachedOwner struct {
	sessionID string
	clientID  string
	projectID string
}

// SetAfterResponse installs a process-lifecycle callback for a successfully
// written request response. It is used by the daemon entrypoint to relinquish a
// listener only after an upgrade ACK has reached the requesting client.
func (server *Server) SetAfterResponse(callback func(protocol.Request)) {
	server.afterResponse = callback
}

// peerUIDReader is deliberately small so connection authorization can be tested
// without depending on the test process's operating-system credentials.
type peerUIDReader func(*net.UnixConn) (uint32, error)

// RequestHandler executes one validated request. The server supplies response
// correlation, so handlers only provide the result payload or an error.
type RequestHandler func(context.Context, protocol.Request) ([]byte, error)

// Listen opens the private Unix socket for one isolated mux home.
func Listen(home Home) (*Server, error) {
	if info, err := os.Lstat(home.SocketPath); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return nil, fmt.Errorf("refuse to replace non-socket at mux path: %s", home.SocketPath)
		}
		if err := os.Remove(home.SocketPath); err != nil {
			return nil, fmt.Errorf("remove stale mux socket: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("inspect mux socket: %w", err)
	}

	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: home.SocketPath, Net: "unix"})
	if err != nil {
		return nil, fmt.Errorf("listen on mux socket: %w", err)
	}
	if err := os.Chmod(home.SocketPath, 0o600); err != nil {
		listener.Close()
		return nil, fmt.Errorf("protect mux socket: %w", err)
	}
	return &Server{
		listener:     listener,
		peerUID:      readPeerUID,
		uid:          uint32(os.Getuid()),
		removeSocket: true,
		stopping:     make(chan struct{}),
		owners:       make(map[string]connectionOwner),
	}, nil
}

// AdoptListener makes a handoff child serve from an inherited listening socket.
// It intentionally does not recreate, chmod, or later unlink the socket path:
// that path is already the live daemon endpoint and remains valid while the old
// process relinquishes its duplicate descriptor.
func AdoptListener(listener *net.UnixListener) (*Server, error) {
	if listener == nil {
		return nil, fmt.Errorf("adopt nil mux listener")
	}
	listener.SetUnlinkOnClose(false)
	return &Server{
		listener:     listener,
		peerUID:      readPeerUID,
		uid:          uint32(os.Getuid()),
		removeSocket: false,
		stopping:     make(chan struct{}),
		owners:       make(map[string]connectionOwner),
	}, nil
}

// ListenerFile duplicates the listening descriptor for SCM_RIGHTS handoff.
// Closing the returned file never stops this server's listener.
func (server *Server) ListenerFile() (*os.File, error) {
	file, err := server.listener.File()
	if err != nil {
		return nil, fmt.Errorf("duplicate mux listener: %w", err)
	}
	return file, nil
}

// CloseForHandoff stops only this process's accept loop. The inheriting child
// keeps the same socket pathname, so Close must not unlink it.
func (server *Server) CloseForHandoff() error {
	server.lifecycleMu.Lock()
	server.removeSocket = false
	server.listener.SetUnlinkOnClose(false)
	server.lifecycleMu.Unlock()
	// Once a child has inherited this listener, a wake-up connection could be
	// accepted by either process. Closing this process's descriptor is therefore
	// the only reliable way to release the old accept loop.
	server.requestStop()
	return server.closeListener()
}

// RemoveSocketOnClose transfers socket-path cleanup to an adopted listener
// once it is the active daemon. It must not be used by a parent completing a
// handoff, because that parent still shares the endpoint with its child.
func (server *Server) RemoveSocketOnClose() {
	server.lifecycleMu.Lock()
	server.removeSocket = true
	server.listener.SetUnlinkOnClose(true)
	server.lifecycleMu.Unlock()
}

// Serve accepts connections until context cancellation or Close. Each connection
// must negotiate Hello before it can issue validated request envelopes.
func (server *Server) Serve(ctx context.Context, handler RequestHandler) error {
	server.lifecycleMu.Lock()
	server.serving = true
	server.lifecycleMu.Unlock()
	defer func() {
		server.lifecycleMu.Lock()
		server.serving = false
		server.lifecycleMu.Unlock()
		_ = server.closeListener()
	}()

	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			server.requestStop()
			server.wakeAccept()
		case <-done:
		}
	}()
	for {
		connection, err := server.listener.AcceptUnix()
		if err != nil {
			if ctx.Err() != nil || server.isStopping() || errors.Is(err, net.ErrClosed) {
				return nil
			}
			return fmt.Errorf("accept mux client: %w", err)
		}
		if ctx.Err() != nil || server.isStopping() {
			_ = connection.Close()
			return nil
		}
		if err := server.authorize(connection); err != nil {
			connection.Close()
			continue
		}
		go server.handleConnection(ctx, connection, handler)
	}
}

func (server *Server) requestStop() {
	server.stopOnce.Do(func() { close(server.stopping) })
}

func (server *Server) isStopping() bool {
	select {
	case <-server.stopping:
		return true
	default:
		return false
	}
}

// wakeAccept connects to the listener so an active AcceptUnix returns without
// closing its descriptor concurrently. On macOS that close/accept combination
// can otherwise leave shutdown blocked in the network poller.
func (server *Server) wakeAccept() {
	address, ok := server.listener.Addr().(*net.UnixAddr)
	if !ok || address.Name == "" {
		return
	}
	connection, err := net.DialUnix("unix", nil, address)
	if err == nil {
		_ = connection.Close()
	}
}

func (server *Server) authorize(connection *net.UnixConn) error {
	uid, err := server.peerUID(connection)
	if err != nil {
		return fmt.Errorf("read mux peer credentials: %w", err)
	}
	if uid != server.uid {
		return fmt.Errorf("refuse mux client from uid %d", uid)
	}
	return nil
}

func (server *Server) handleConnection(ctx context.Context, connection *net.UnixConn, handler RequestHandler) {
	defer func() {
		server.detachConnection(ctx, connection, handler)
		_ = connection.Close()
	}()
	var hello protocol.Hello
	if err := protocol.Read(connection, &hello); err != nil {
		return
	}
	if err := protocol.ValidateHello(hello); err != nil {
		// A version mismatch is a recoverable compatibility diagnosis for a tty
		// fallback client. It is deliberately a response with id 0 because no
		// request has been accepted yet; compliant clients surface its message and
		// then observe the closed connection.
		_ = protocol.Write(connection, protocol.Response{Error: err.Error()})
		return
	}
	for {
		var request protocol.Request
		if err := protocol.Read(connection, &request); err != nil {
			return
		}
		if err := protocol.ValidateRequest(request); err != nil {
			return
		}

		data, err := handler(ctx, request)
		response := protocol.Response{ID: request.ID, Data: data}
		if err != nil {
			response.Error = err.Error()
		}
		// Lifecycle commits (notably a successful handoff) cannot depend on a
		// requester keeping its socket open long enough to receive this response.
		// The handler already returned a committed result, so retire the old
		// accept loop before a best-effort response write.
		if err == nil && request.Method == methodSessionAttach {
			var input AttachSessionRequest
			if decodeErr := decodeOperation(request.Data, &input); decodeErr == nil {
				server.claimAttach(input, connection, request.ProjectID)
			}
		}
		if server.afterResponse != nil {
			server.afterResponse(request)
		}
		if err := protocol.Write(connection, response); err != nil {
			return
		}
	}
}

func (server *Server) claimAttach(input AttachSessionRequest, connection *net.UnixConn, projectID string) {
	if input.SessionID == "" || input.ClientID == "" {
		return
	}
	server.ownerMu.Lock()
	previous, exists := server.owners[input.SessionID]
	server.owners[input.SessionID] = connectionOwner{connection: connection, clientID: input.ClientID, clientKind: input.ClientKind, projectID: projectID}
	server.ownerMu.Unlock()
	if !exists || previous.connection == connection {
		return
	}
	if previous.clientID != input.ClientID {
		_ = protocol.Write(previous.connection, protocol.Event{Event: "session.stolen", SessionID: input.SessionID, ByKind: input.ClientKind})
	}
	_ = previous.connection.Close()
}

func (server *Server) detachConnection(ctx context.Context, connection *net.UnixConn, handler RequestHandler) {
	server.ownerMu.Lock()
	owners := make([]detachedOwner, 0)
	for sessionID, owner := range server.owners {
		if owner.connection == connection {
			delete(server.owners, sessionID)
			owners = append(owners, detachedOwner{sessionID: sessionID, clientID: owner.clientID, projectID: owner.projectID})
		}
	}
	server.ownerMu.Unlock()

	for _, owner := range owners {
		data, err := msgpack.Marshal(DetachSessionRequest{SessionID: owner.sessionID, ClientID: owner.clientID})
		if err != nil {
			continue
		}
		_, _ = handler(ctx, protocol.Request{Method: methodSessionDetach, ProjectID: owner.projectID, Data: data})
	}
}

// Close stops accepting clients and removes the socket path. A serving listener
// is woken rather than closed from a second goroutine, because macOS can block
// that concurrent close while AcceptUnix is active.
func (server *Server) Close() error {
	server.requestStop()
	server.lifecycleMu.Lock()
	serving := server.serving
	server.lifecycleMu.Unlock()
	if serving {
		server.wakeAccept()
		return nil
	}
	return server.closeListener()
}

func (server *Server) closeListener() error {
	var closeErr error
	server.closeOnce.Do(func() {
		closeErr = server.listener.Close()
		server.lifecycleMu.Lock()
		removeSocket := server.removeSocket
		server.lifecycleMu.Unlock()
		if removeSocket {
			address, ok := server.listener.Addr().(*net.UnixAddr)
			if !ok {
				return
			}
			if err := os.Remove(address.Name); err != nil && !errors.Is(err, os.ErrNotExist) && closeErr == nil {
				closeErr = err
			}
		}
	})
	return closeErr
}
