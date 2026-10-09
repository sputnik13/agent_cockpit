// Command cockpit-mux starts the standalone local M1A daemon.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/local-repo-explorer/cockpit-mux/daemon"
	"github.com/local-repo-explorer/cockpit-mux/protocol"
	"github.com/vmihailenco/msgpack/v5"
	"golang.org/x/sys/unix"
	"golang.org/x/term"
)

// Version and SourceHash are embedded by the release build. Development builds
// retain explicit values so remote provisioning treats them as potentially stale.
var (
	Version    = "0.1.41"
	SourceHash = "dev"
)

const handoffBudget = 5 * time.Second

// muxUpgradeRequest is sent only by a launcher after it has selected and
// checksum-verified a manifest artifact. The daemon independently verifies the
// candidate's embedded source hash before it pauses any live pane.
type muxUpgradeRequest struct {
	BinaryPath string `msgpack:"binary_path"`
	SourceHash string `msgpack:"source_hash"`
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "cockpit-mux:", err)
		os.Exit(1)
	}
}

func run(arguments []string) error {
	if len(arguments) == 1 && (arguments[0] == "version" || arguments[0] == "--version") {
		fmt.Fprintln(os.Stdout, SourceHash)
		return nil
	}
	context, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	return runContext(context, arguments)
}

func runContext(parentContext context.Context, arguments []string) (runErr error) {
	flags := flag.NewFlagSet("cockpit-mux", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	home := flags.String("home", defaultHome(), "private mux runtime directory")
	persistScrollback := flags.Bool("persist-scrollback", true, "persist terminal screen and scrollback in the private mux database")
	scrollbackLines := flags.Uint("scrollback-lines", uint(daemon.DefaultScrollbackLines), "finite live scrollback target per pane")
	socket := flags.String("socket", "", "mux Unix socket (attach only)")
	pane := flags.String("pane", "", "mux pane id (attach only)")
	ownerFD := flags.Int("owner-fd", -1, "inherited owner pipe descriptor; daemon exits when its writer closes")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	if *scrollbackLines == 0 || *scrollbackLines > daemon.MaxScrollbackLines {
		return fmt.Errorf("scrollback-lines must be between 1 and %d", daemon.MaxScrollbackLines)
	}
	if flags.NArg() >= 1 && flags.Arg(0) == "bridge" {
		if flags.NArg() != 1 {
			return fmt.Errorf("bridge does not accept a session name")
		}
		path := *socket
		if path == "" {
			path = runtimeSocket(*home)
		}
		return bridgeSocket(path, os.Stdin, os.Stdout)
	}
	if flags.NArg() == 1 && flags.Arg(0) == "handoff-verify" {
		if *socket == "" {
			return fmt.Errorf("handoff-verify requires --socket inherited-handoff-fd")
		}
		return verifyHandoffChild(*socket)
	}
	if flags.NArg() == 1 && flags.Arg(0) == "handoff" {
		if *socket == "" {
			return fmt.Errorf("handoff requires --socket inherited-handoff-fd")
		}
		return handoffChild(parentContext, *home, *socket, *persistScrollback, *scrollbackLines, *ownerFD)
	}
	if flags.NArg() >= 1 && flags.Arg(0) == "attach" {
		if flags.NArg() > 2 {
			return fmt.Errorf("usage: cockpit-mux [--pane pane-id] attach [session-id]")
		}
		path := *socket
		if path == "" {
			path = runtimeSocket(*home)
		}
		sessionID := ""
		if flags.NArg() == 2 {
			sessionID = flags.Arg(1)
		}
		return attachMuxSession(path, sessionID, *pane, os.Stdin, os.Stdout)
	}
	if flags.NArg() == 1 && flags.Arg(0) == "ls" {
		path := *socket
		if path == "" {
			path = runtimeSocket(*home)
		}
		return listMuxSessions(path, os.Stdout)
	}
	if flags.NArg() >= 1 && (flags.Arg(0) == "window" || flags.Arg(0) == "pane") {
		path := *socket
		if path == "" {
			path = runtimeSocket(*home)
		}
		return runTopologyControl(path, flags.Args(), os.Stdout)
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unsupported command %q", flags.Arg(0))
	}
	serverContext, ownerFile, releaseOwner, err := contextWithOwner(parentContext, *ownerFD)
	if err != nil {
		return err
	}
	defer releaseOwner()

	runtime, err := daemon.OpenHome(*home)
	if err != nil {
		return err
	}
	if _, err := daemon.ConfigureTerminfo(runtime); err != nil {
		return err
	}
	if err := recordDaemonSourceHash(runtime.Path, SourceHash); err != nil {
		return fmt.Errorf("record daemon source hash: %w", err)
	}
	operations := daemon.NewPersistentOperationsWithOptions(runtime, daemon.PersistentOptions{PersistScrollback: *persistScrollback, ScrollbackLines: *scrollbackLines})
	handoffCommitted := false
	defer func() {
		if !handoffCommitted {
			if closeErr := operations.Close(); closeErr != nil {
				runErr = errors.Join(runErr, closeErr)
			}
		}
	}()
	server, err := daemon.Listen(runtime)
	if err != nil {
		return err
	}
	defer server.Close()

	serveContext, stop := context.WithCancel(serverContext)
	defer stop()
	server.SetAfterResponse(func(request protocol.Request) {
		if request.Method == "mux.upgrade" && handoffCommitted {
			_ = server.CloseForHandoff()
			stop()
		}
	})
	return server.Serve(serveContext, func(requestContext context.Context, request protocol.Request) ([]byte, error) {
		if request.Method == "mux.upgrade" {
			var input muxUpgradeRequest
			if decodeErr := msgpack.Unmarshal(request.Data, &input); decodeErr != nil {
				return nil, fmt.Errorf("decode mux upgrade request: %w", decodeErr)
			}
			response, upgradeErr := upgradeMux(requestContext, runtime, server, operations, input, ownerFile)
			if upgradeErr == nil {
				handoffCommitted = true
			}
			return response, upgradeErr
		}
		response, handleErr := operations.Handle(requestContext, request)
		if handleErr == nil && request.Method == "mux.shutdown" {
			stop()
		}
		return response, handleErr
	})
}

// cockpitShell is the same trampoline Cockpit uses for a mux-created terminal:
// it preserves the user's configured default shell while preventing byobu from
// autostarting inside a pane that already belongs to the mux.
var cockpitShell = []string{"/usr/bin/env", "BYOBU_DISABLE=1", "/bin/sh", "-c", `exec "${SHELL:-/bin/sh}"`}

type topologyControlResponse struct {
	SessionID string `json:"sessionId"`
	PaneID    string `json:"paneId"`
}

// runTopologyControl provides a scriptable local surface over the same
// authenticated protocol used by the Cockpit renderer. It intentionally does
// not emulate keypresses or require a terminal, which lets agent harnesses
// build a session topology deterministically.
//
// Usage:
//
//	cockpit-mux [--home PATH] window new --session SESSION [--cwd DIR] [-- command args...]
//	cockpit-mux [--home PATH] pane split --pane PANE [--direction horizontal|vertical] [--cwd DIR] [-- command args...]
func runTopologyControl(socket string, arguments []string, output io.Writer) error {
	if len(arguments) < 2 {
		return errors.New("usage: cockpit-mux window new ... or cockpit-mux pane split ...")
	}
	command, operation := arguments[0], arguments[1]
	if (command != "window" || operation != "new") && (command != "pane" || operation != "split") {
		return fmt.Errorf("unsupported topology command %q %q", command, operation)
	}
	flags := flag.NewFlagSet(command+" "+operation, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	sessionID := flags.String("session", "", "logical mux session id")
	paneID := flags.String("pane", "", "mux pane id")
	cwd := flags.String("cwd", "", "working directory for the new shell")
	key := flags.String("key", "", "optional caller key")
	direction := flags.String("direction", "horizontal", "split direction: horizontal or vertical")
	ratio := flags.Float64("ratio", 0.5, "first-child split ratio")
	if err := flags.Parse(arguments[2:]); err != nil {
		return err
	}
	program, args := muxLaunchCommand(flags.Args())
	if *key == "" {
		*key = fmt.Sprintf("cli-%d-%d", os.Getpid(), time.Now().UnixNano())
	}
	client, err := dialMuxSocket(socket)
	if err != nil {
		return err
	}
	defer client.Close()
	var response daemon.CreateSessionResponse
	switch command {
	case "window":
		if *sessionID == "" {
			return errors.New("window new requires --session")
		}
		projectID, projectErr := client.projectForLogicalSession(*sessionID)
		if projectErr != nil {
			return projectErr
		}
		err = client.requestForProject(projectID, "window.new", daemon.NewWindowRequest{
			SessionID: *sessionID, Command: program, Args: args, Cwd: *cwd, Key: *key,
		}, &response)
	case "pane":
		if *paneID == "" {
			return errors.New("pane split requires --pane")
		}
		if *direction != "horizontal" && *direction != "vertical" {
			return fmt.Errorf("pane split direction must be horizontal or vertical, got %q", *direction)
		}
		if math.IsNaN(*ratio) || math.IsInf(*ratio, 0) || *ratio <= 0 || *ratio >= 1 {
			return fmt.Errorf("pane split ratio must be greater than 0 and less than 1")
		}
		projectID, projectErr := client.projectForPane(*paneID)
		if projectErr != nil {
			return projectErr
		}
		err = client.requestForProject(projectID, "pane.split", daemon.SplitPaneRequest{
			PaneID: *paneID, Command: program, Args: args, Cwd: *cwd, Key: *key, Direction: *direction, Ratio: *ratio,
		}, &response)
	}
	if err != nil {
		return err
	}
	if err := json.NewEncoder(output).Encode(topologyControlResponse{SessionID: response.SessionID, PaneID: response.PaneID}); err != nil {
		return fmt.Errorf("write topology control response: %w", err)
	}
	return nil
}

func muxLaunchCommand(arguments []string) (string, []string) {
	if len(arguments) == 0 {
		return cockpitShell[0], append([]string(nil), cockpitShell[1:]...)
	}
	return arguments[0], append([]string(nil), arguments[1:]...)
}

func handoffChild(parentContext context.Context, homePath, inheritedDescriptor string, persistScrollback bool, scrollbackLines uint, ownerFD int) (runErr error) {
	ownerContext, ownerFile, releaseOwner, err := contextWithOwner(parentContext, ownerFD)
	if err != nil {
		return err
	}
	defer releaseOwner()
	connection, err := inheritedHandoffConnection(inheritedDescriptor)
	if err != nil {
		return err
	}
	defer connection.Close()
	manifest, descriptors, receiveErr := daemon.ReceiveHandoff(connection)
	defer closeHandoffDescriptors(descriptors)
	result := daemon.HandoffResult{Accepted: receiveErr == nil}
	if receiveErr != nil {
		result.Error = receiveErr.Error()
		_ = protocol.Write(connection, result)
		return fmt.Errorf("mux handoff rejected: %s", result.Error)
	}
	runtime, err := daemon.OpenHome(homePath)
	if err != nil {
		result.Accepted, result.Error = false, err.Error()
		_ = protocol.Write(connection, result)
		return fmt.Errorf("mux handoff rejected: %s", result.Error)
	}
	if _, err := daemon.ConfigureTerminfo(runtime); err != nil {
		result.Accepted, result.Error = false, err.Error()
		_ = protocol.Write(connection, result)
		return fmt.Errorf("mux handoff rejected: %s", result.Error)
	}
	if manifest.ListenerIndex < 0 || manifest.ListenerIndex >= len(descriptors) {
		result.Accepted, result.Error = false, "mux handoff has no listener descriptor"
		_ = protocol.Write(connection, result)
		return fmt.Errorf("mux handoff rejected: %s", result.Error)
	}
	listenerFile := descriptors[manifest.ListenerIndex]
	listener, err := net.FileListener(listenerFile)
	if err == nil {
		err = listenerFile.Close()
	}
	descriptors[manifest.ListenerIndex] = nil
	if err != nil {
		result.Accepted, result.Error = false, fmt.Sprintf("adopt mux handoff listener: %v", err)
		_ = protocol.Write(connection, result)
		return fmt.Errorf("mux handoff rejected: %s", result.Error)
	}
	unixListener, ok := listener.(*net.UnixListener)
	if !ok {
		_ = listener.Close()
		result.Accepted, result.Error = false, "inherited mux listener is not a Unix socket"
		_ = protocol.Write(connection, result)
		return fmt.Errorf("mux handoff rejected: %s", result.Error)
	}
	server, err := daemon.AdoptListener(unixListener)
	if err != nil {
		_ = unixListener.Close()
		result.Accepted, result.Error = false, err.Error()
		_ = protocol.Write(connection, result)
		return fmt.Errorf("mux handoff rejected: %s", result.Error)
	}
	defer server.Close()
	operations := daemon.NewHandoffOperations(runtime, persistScrollback, scrollbackLines)
	handoffAccepted := false
	handoffCommitted := false
	defer func() {
		if !handoffAccepted {
			if abandonErr := operations.AbandonHandoff(); abandonErr != nil {
				runErr = errors.Join(runErr, abandonErr)
			}
		} else if !handoffCommitted {
			if closeErr := operations.Close(); closeErr != nil {
				runErr = errors.Join(runErr, closeErr)
			}
		}
	}()
	if err := operations.AdoptHandoff(manifest, descriptors); err != nil {
		result.Accepted, result.Error = false, err.Error()
		_ = protocol.Write(connection, result)
		return fmt.Errorf("mux handoff rejected: %s", result.Error)
	}
	if err := recordDaemonSourceHash(runtime.Path, SourceHash); err != nil {
		result.Accepted, result.Error = false, err.Error()
		_ = protocol.Write(connection, result)
		return fmt.Errorf("mux handoff rejected: %s", result.Error)
	}
	if err := protocol.Write(connection, result); err != nil {
		return fmt.Errorf("write mux handoff result: %w", err)
	}
	handoffAccepted = true
	// The ACK is the ownership commit point. Before this succeeds, closing the
	// inherited listener must leave the parent's Unix socket path intact.
	server.RemoveSocketOnClose()
	if err := operations.ActivateHandoffPersistence(); err != nil {
		// The transfer is already committed; keep serving the adopted PTYs and
		// report the persistence fault rather than killing the only live owner.
		fmt.Fprintf(os.Stderr, "cockpit-mux: activate handoff persistence: %v\n", err)
	}
	serveContext, stop := context.WithCancel(ownerContext)
	defer stop()
	server.SetAfterResponse(func(request protocol.Request) {
		if request.Method == "mux.upgrade" && handoffCommitted {
			_ = server.CloseForHandoff()
			stop()
		}
	})
	return server.Serve(serveContext, func(requestContext context.Context, request protocol.Request) ([]byte, error) {
		if request.Method == "mux.upgrade" {
			var input muxUpgradeRequest
			if decodeErr := msgpack.Unmarshal(request.Data, &input); decodeErr != nil {
				return nil, fmt.Errorf("decode mux upgrade request: %w", decodeErr)
			}
			response, upgradeErr := upgradeMux(requestContext, runtime, server, operations, input, ownerFile)
			if upgradeErr == nil {
				handoffCommitted = true
			}
			return response, upgradeErr
		}
		response, handleErr := operations.Handle(requestContext, request)
		if handleErr == nil && request.Method == "mux.shutdown" {
			stop()
		}
		return response, handleErr
	})
}

func upgradeMux(parentContext context.Context, runtime daemon.Home, server *daemon.Server, operations *daemon.Operations, input muxUpgradeRequest, ownerFile *os.File) ([]byte, error) {
	target, err := verifyUpgradeTarget(parentContext, input)
	if err != nil {
		return nil, err
	}
	context, cancel := context.WithTimeout(parentContext, handoffBudget)
	defer cancel()
	prepared, err := operations.PrepareHandoff(context)
	if err != nil {
		return nil, err
	}
	committed := false
	defer func() {
		if !committed {
			prepared.Release()
			// The child writes its marker before sending ACK. If that ACK never
			// reaches this parent, the old process remains authoritative and must
			// restore its own marker so future launchers retry the upgrade.
			_ = recordDaemonSourceHash(runtime.Path, SourceHash)
		}
	}()
	listenerFile, err := server.ListenerFile()
	if err != nil {
		return nil, err
	}
	defer listenerFile.Close()
	manifest := prepared.Manifest
	manifest.ListenerIndex = 0
	for index := range manifest.Panes {
		manifest.Panes[index].MasterIndex++
	}
	descriptors := append([]*os.File{listenerFile}, prepared.Masters...)
	parent, child, err := handoffSocketPair()
	if err != nil {
		return nil, err
	}
	defer parent.Close()
	childFile, err := child.File()
	if err != nil {
		_ = child.Close()
		return nil, err
	}
	child.Close()
	command := newHandoffChildCommand(target, runtime.Path, operations.PersistScrollback(), operations.ScrollbackLines(), childFile, ownerFile)
	if err := command.Start(); err != nil {
		_ = childFile.Close()
		return nil, fmt.Errorf("start mux handoff child: %w", err)
	}
	_ = childFile.Close()
	if err := parent.SetDeadline(time.Now().Add(handoffBudget)); err != nil {
		return nil, fmt.Errorf("set mux handoff deadline: %w", err)
	}
	if err := daemon.SendHandoff(parent, manifest, descriptors); err != nil {
		_ = parent.Close()
		waitHandoffChild(command)
		return nil, err
	}
	var result daemon.HandoffResult
	if err := protocol.Read(parent, &result); err != nil {
		_ = parent.Close()
		waitHandoffChild(command)
		return nil, fmt.Errorf("read mux handoff result: %w", err)
	}
	if !result.Accepted {
		_ = parent.Close()
		waitHandoffChild(command)
		return nil, fmt.Errorf("mux handoff rejected: %s", result.Error)
	}
	committed = true
	return msgpack.Marshal(struct{}{})
}

func recordDaemonSourceHash(homePath, sourceHash string) error {
	if err := os.WriteFile(filepath.Join(homePath, "daemon-source-hash"), []byte(sourceHash+"\n"), 0o600); err != nil {
		return fmt.Errorf("record daemon source hash: %w", err)
	}
	return nil
}

func verifyUpgradeTarget(parentContext context.Context, input muxUpgradeRequest) (string, error) {
	if input.BinaryPath == "" || input.SourceHash == "" {
		return "", fmt.Errorf("mux upgrade requires a verified binary path and source hash")
	}
	targetPath := input.BinaryPath
	if strings.HasPrefix(targetPath, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolve mux upgrade home: %w", err)
		}
		targetPath = filepath.Join(home, strings.TrimPrefix(targetPath, "~/"))
	}
	if !filepath.IsAbs(targetPath) {
		return "", fmt.Errorf("mux upgrade binary path must be absolute")
	}
	target, err := filepath.EvalSymlinks(targetPath)
	if err != nil {
		return "", fmt.Errorf("resolve mux upgrade binary: %w", err)
	}
	info, err := os.Stat(target)
	if err != nil {
		return "", fmt.Errorf("inspect mux upgrade binary: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
		return "", fmt.Errorf("mux upgrade target is not an executable file: %s", target)
	}
	context, cancel := context.WithTimeout(parentContext, handoffBudget)
	defer cancel()
	output, err := exec.CommandContext(context, target, "version").Output()
	if err != nil {
		return "", fmt.Errorf("read mux upgrade target version: %w", err)
	}
	if got := strings.TrimSpace(string(output)); got != input.SourceHash {
		return "", fmt.Errorf("mux upgrade target source hash mismatch: got %q, want %q", got, input.SourceHash)
	}
	return target, nil
}

// newHandoffChildCommand is a package variable so the native integration test
// can make a real replacement process NACK before the old daemon releases its
// prepared descriptors. Production always launches the verified replacement
// artifact rather than re-executing the currently running binary.
var newHandoffChildCommand = func(binaryPath, homePath string, persistScrollback bool, scrollbackLines uint, childFile, ownerFile *os.File) *exec.Cmd {
	arguments := []string{"--home", homePath, "--persist-scrollback=" + strconv.FormatBool(persistScrollback), "--scrollback-lines=" + strconv.FormatUint(uint64(scrollbackLines), 10), "--socket=3"}
	extraFiles := []*os.File{childFile}
	if ownerFile != nil {
		arguments = append(arguments, "--owner-fd=4")
		extraFiles = append(extraFiles, ownerFile)
	}
	arguments = append(arguments, "handoff")
	command := exec.Command(binaryPath, arguments...)
	command.ExtraFiles = extraFiles
	return command
}

// contextWithOwner ties a daemon to an Electron-owned pipe. EOF is delivered
// when Electron exits, including SIGKILL, and cancellation runs normal daemon
// teardown so its PTYs and process groups are reaped.
func contextWithOwner(parent context.Context, descriptor int) (context.Context, *os.File, func(), error) {
	if descriptor < 0 {
		return parent, nil, func() {}, nil
	}
	if descriptor < 3 {
		return nil, nil, nil, fmt.Errorf("owner pipe descriptor must be at least 3")
	}
	ownerFile := os.NewFile(uintptr(descriptor), "cockpit-mux-owner")
	if ownerFile == nil {
		return nil, nil, nil, fmt.Errorf("open owner pipe descriptor %d", descriptor)
	}
	ctx, cancel := context.WithCancel(parent)
	go func() {
		_, _ = io.Copy(io.Discard, ownerFile)
		cancel()
	}()
	return ctx, ownerFile, func() {
		cancel()
		_ = ownerFile.Close()
	}, nil
}

// waitHandoffChild bounds every NACK/timeout cleanup path. The old daemon keeps
// its paused readers only until upgradeMux returns, so a stuck replacement must
// never turn a failed handoff into an indefinite pause.
func waitHandoffChild(command *exec.Cmd) {
	done := make(chan struct{})
	go func() {
		_ = command.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		_ = command.Process.Kill()
		<-done
	}
}

func inheritedHandoffConnection(value string) (*net.UnixConn, error) {
	descriptor, err := strconv.Atoi(value)
	if err != nil || descriptor < 0 {
		return nil, fmt.Errorf("invalid inherited handoff descriptor %q", value)
	}
	file := os.NewFile(uintptr(descriptor), "mux-handoff")
	if file == nil {
		return nil, fmt.Errorf("open inherited handoff descriptor")
	}
	connection, err := net.FileConn(file)
	_ = file.Close()
	if err != nil {
		return nil, fmt.Errorf("adopt inherited handoff descriptor: %w", err)
	}
	unixConnection, ok := connection.(*net.UnixConn)
	if !ok {
		_ = connection.Close()
		return nil, fmt.Errorf("inherited handoff descriptor is not a Unix socket")
	}
	return unixConnection, nil
}

func handoffSocketPair() (*net.UnixConn, *net.UnixConn, error) {
	descriptors, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_STREAM, 0)
	if err != nil {
		return nil, nil, fmt.Errorf("create mux handoff socket pair: %w", err)
	}
	leftFile := os.NewFile(uintptr(descriptors[0]), "mux-handoff-parent")
	rightFile := os.NewFile(uintptr(descriptors[1]), "mux-handoff-child")
	left, err := net.FileConn(leftFile)
	_ = leftFile.Close()
	if err != nil {
		_ = rightFile.Close()
		return nil, nil, err
	}
	right, err := net.FileConn(rightFile)
	_ = rightFile.Close()
	if err != nil {
		_ = left.Close()
		return nil, nil, err
	}
	parent, parentOK := left.(*net.UnixConn)
	child, childOK := right.(*net.UnixConn)
	if !parentOK || !childOK {
		_ = left.Close()
		_ = right.Close()
		return nil, nil, fmt.Errorf("mux handoff socket pair is not Unix")
	}
	return parent, child, nil
}

func closeHandoffDescriptors(descriptors []*os.File) {
	for _, descriptor := range descriptors {
		if descriptor != nil {
			_ = descriptor.Close()
		}
	}
}

func runtimeSocket(home string) string {
	path, _ := daemon.SocketPath(home)
	return path
}

// verifyHandoffChild is the new-daemon preflight mode used by the future live
// upgrade transaction. Its socket argument is an inherited numeric descriptor,
// never a filesystem socket path. It imports every Snapshot v1 and returns an
// explicit ACK/NACK while the parent still owns all PTY masters.
func verifyHandoffChild(inheritedDescriptor string) error {
	var descriptor int
	if _, err := fmt.Sscanf(inheritedDescriptor, "%d", &descriptor); err != nil || descriptor < 0 {
		return fmt.Errorf("invalid inherited handoff descriptor %q", inheritedDescriptor)
	}
	file := os.NewFile(uintptr(descriptor), "mux-handoff")
	if file == nil {
		return fmt.Errorf("open inherited handoff descriptor")
	}
	defer file.Close()
	connection, err := net.FileConn(file)
	if err != nil {
		return fmt.Errorf("adopt inherited handoff descriptor: %w", err)
	}
	defer connection.Close()
	unixConnection, ok := connection.(*net.UnixConn)
	if !ok {
		return fmt.Errorf("inherited handoff descriptor is not a Unix socket")
	}
	manifest, masters, receiveErr := daemon.ReceiveHandoff(unixConnection)
	for _, master := range masters {
		defer master.Close()
	}
	result := daemon.HandoffResult{Accepted: receiveErr == nil}
	if receiveErr != nil {
		result.Error = receiveErr.Error()
	} else if verifyErr := daemon.VerifyHandoffManifest(manifest); verifyErr != nil {
		result.Accepted = false
		result.Error = verifyErr.Error()
	}
	if err := protocol.Write(unixConnection, result); err != nil {
		return fmt.Errorf("write mux handoff result: %w", err)
	}
	if !result.Accepted {
		return fmt.Errorf("mux handoff rejected: %s", result.Error)
	}
	return nil
}

// bridgeSocket is the M2 remote exec-channel client: stdin/stdout are relayed
// byte-for-byte to the private mux socket, with no terminal/line processing.
// It remains distinct from attach so the Cockpit transport does not accidentally
// inherit local TTY behavior.
func bridgeSocket(socket string, input io.Reader, output io.Writer) error {
	connection, err := net.Dial("unix", socket)
	if err != nil {
		return fmt.Errorf("connect mux socket: %w", err)
	}
	defer connection.Close()
	done := make(chan error, 1)
	go func() {
		_, err := io.Copy(connection, input)
		if closeErr := connection.(*net.UnixConn).CloseWrite(); err == nil {
			err = closeErr
		}
		done <- err
	}()
	_, outputErr := io.Copy(output, connection)
	_ = connection.Close()
	inputErr := <-done
	if outputErr != nil && outputErr != io.EOF {
		return outputErr
	}
	if inputErr != nil && inputErr != io.EOF {
		return inputErr
	}
	return nil
}

type muxSocketClient struct {
	connection net.Conn
	nextID     uint64
}

func dialMuxSocket(socket string) (*muxSocketClient, error) {
	connection, err := net.Dial("unix", socket)
	if err != nil {
		return nil, fmt.Errorf("connect mux socket: %w", err)
	}
	client := &muxSocketClient{connection: connection}
	if err := protocol.Write(connection, protocol.Hello{Protocol: protocol.Version}); err != nil {
		_ = connection.Close()
		return nil, fmt.Errorf("negotiate mux protocol: %w", err)
	}
	return client, nil
}

func (client *muxSocketClient) Close() error { return client.connection.Close() }

func (client *muxSocketClient) request(method string, input, output any) error {
	return client.requestForProject("", method, input, output)
}

func (client *muxSocketClient) requestForProject(projectID, method string, input, output any) error {
	data, err := msgpack.Marshal(input)
	if err != nil {
		return fmt.Errorf("encode %s: %w", method, err)
	}
	client.nextID++
	if err := protocol.Write(client.connection, protocol.Request{ID: client.nextID, Method: method, ProjectID: projectID, Data: data}); err != nil {
		return fmt.Errorf("request %s: %w", method, err)
	}
	var response protocol.Response
	if err := protocol.Read(client.connection, &response); err != nil {
		return fmt.Errorf("read %s response: %w", method, err)
	}
	if response.ID != client.nextID {
		if response.ID == 0 && response.Error != "" {
			return errors.New(response.Error)
		}
		return fmt.Errorf("read %s response: unexpected response id %d", method, response.ID)
	}
	if response.Error != "" {
		return errors.New(response.Error)
	}
	if err := msgpack.Unmarshal(response.Data, output); err != nil {
		return fmt.Errorf("decode %s response: %w", method, err)
	}
	return nil
}

func (client *muxSocketClient) listSessions() (daemon.ListSessionsResponse, error) {
	var listed daemon.ListSessionsResponse
	err := client.request("session.list", struct{}{}, &listed)
	return listed, err
}

func (client *muxSocketClient) projectForLogicalSession(logicalID string) (string, error) {
	listed, err := client.listSessions()
	if err != nil {
		return "", err
	}
	for _, session := range listed.Sessions {
		if session.SessionID == logicalID || session.LogicalSessionID == logicalID {
			return session.ProjectID, nil
		}
	}
	return "", fmt.Errorf("mux logical session %q was not found", logicalID)
}

func (client *muxSocketClient) projectForPane(paneID string) (string, error) {
	listed, err := client.listSessions()
	if err != nil {
		return "", err
	}
	for _, session := range listed.Sessions {
		if session.PaneID == paneID {
			return session.ProjectID, nil
		}
	}
	return "", fmt.Errorf("mux pane %q was not found", paneID)
}

// listMuxSessions is the standalone fallback's discovery command. It uses the
// same authenticated local socket and negotiated wire protocol as Cockpit, but
// intentionally has no terminal or Cockpit dependency.
func listMuxSessions(socket string, output io.Writer) error {
	client, err := dialMuxSocket(socket)
	if err != nil {
		return err
	}
	defer client.Close()
	listed, err := client.listSessions()
	if err != nil {
		return err
	}
	for _, session := range listed.Sessions {
		state := "live"
		if session.Exited {
			state = "exited"
		}
		if _, err := fmt.Fprintf(output, "%s\t%s\t%s\t%s\t%s\n", session.SessionID, session.Key, session.PaneID, state, session.ProjectID); err != nil {
			return fmt.Errorf("write session list: %w", err)
		}
	}
	return nil
}

// attachMuxSession is the deliberately small fallback terminal client. It owns
// a single TTY, restores it on every exit path, and only emits server-produced
// bytes; Cockpit continues to use bridgeSocket for its framed exec channel.
func attachMuxSession(socket, requestedSession, requestedPane string, input *os.File, output io.Writer) error {
	if !term.IsTerminal(int(input.Fd())) {
		return errors.New("attach requires a TTY on standard input")
	}
	client, err := dialMuxSocket(socket)
	if err != nil {
		return err
	}
	defer client.Close()

	listed, err := client.listSessions()
	if err != nil {
		return err
	}
	session, err := selectLiveSession(listed.Sessions, requestedSession, requestedPane)
	if err != nil {
		return err
	}
	cols, rows, err := term.GetSize(int(input.Fd()))
	if err != nil {
		return fmt.Errorf("read TTY size: %w", err)
	}
	state, err := term.MakeRaw(int(input.Fd()))
	if err != nil {
		return fmt.Errorf("enter raw TTY mode: %w", err)
	}
	defer term.Restore(int(input.Fd()), state)

	clientID := fmt.Sprintf("tty-%d", os.Getpid())
	var attached daemon.AttachSessionResponse
	if err := client.requestForProject(session.ProjectID, "session.attach", daemon.AttachSessionRequest{
		SessionID:  session.SessionID,
		ClientID:   clientID,
		ClientKind: "tty",
		Cols:       uint16(cols),
		Rows:       uint16(rows),
	}, &attached); err != nil {
		return err
	}
	defer func() {
		var ignored struct{}
		_ = client.requestForProject(session.ProjectID, "session.detach", daemon.DetachSessionRequest{SessionID: session.SessionID, ClientID: clientID}, &ignored)
	}()
	if _, err := output.Write(attached.Seed); err != nil {
		return fmt.Errorf("write mux attach seed: %w", err)
	}

	return relayAttachedSession(client, session.ProjectID, attached.PaneID, attached.ResumeSequence, clientID, input, output)
}

func selectLiveSession(sessions []daemon.SessionListItem, requested, requestedPane string) (daemon.SessionListItem, error) {
	var live []daemon.SessionListItem
	for _, session := range sessions {
		if !session.Exited {
			live = append(live, session)
		}
	}
	if requested != "" || requestedPane != "" {
		for _, session := range live {
			if (requested == "" || session.SessionID == requested) && (requestedPane == "" || session.PaneID == requestedPane) {
				return session, nil
			}
		}
		if requestedPane != "" {
			return daemon.SessionListItem{}, fmt.Errorf("live mux pane %q was not found", requestedPane)
		}
		return daemon.SessionListItem{}, fmt.Errorf("live mux session %q was not found", requested)
	}
	if len(live) == 1 {
		return live[0], nil
	}
	if len(live) == 0 {
		return daemon.SessionListItem{}, errors.New("no live mux sessions; run cockpit-mux ls")
	}
	ids := make([]string, 0, len(live))
	for _, session := range live {
		ids = append(ids, session.SessionID)
	}
	return daemon.SessionListItem{}, fmt.Errorf("multiple live mux sessions (%s); run cockpit-mux attach <session-id>", strings.Join(ids, ", "))
}

func relayAttachedSession(client *muxSocketClient, projectID, paneID string, nextSequence uint64, clientID string, input *os.File, output io.Writer) error {
	inputChunks := make(chan []byte, 1)
	inputErr := make(chan error, 1)
	go readTerminalInput(input, inputChunks, inputErr)

	resize := make(chan os.Signal, 1)
	signal.Notify(resize, syscall.SIGWINCH)
	defer signal.Stop(resize)
	poll := time.NewTicker(20 * time.Millisecond)
	defer poll.Stop()
	pendingPrefix := false

	for {
		select {
		case chunk := <-inputChunks:
			forward, detach := splitDetachChord(chunk, &pendingPrefix)
			if len(forward) > 0 {
				var wrote daemon.WritePaneResponse
				if err := client.requestForProject(projectID, "pane.write", daemon.WritePaneRequest{PaneID: paneID, ClientID: clientID, Data: forward, Kind: "input"}, &wrote); err != nil {
					return err
				}
			}
			if detach {
				return nil
			}
		case err := <-inputErr:
			if pendingPrefix {
				var wrote daemon.WritePaneResponse
				if writeErr := client.requestForProject(projectID, "pane.write", daemon.WritePaneRequest{PaneID: paneID, ClientID: clientID, Data: []byte{0x02}, Kind: "input"}, &wrote); writeErr != nil {
					return writeErr
				}
			}
			if err == nil || errors.Is(err, io.EOF) {
				return nil
			}
			return fmt.Errorf("read TTY input: %w", err)
		case <-resize:
			cols, rows, err := term.GetSize(int(input.Fd()))
			if err != nil {
				return fmt.Errorf("read resized TTY: %w", err)
			}
			if err := client.requestForProject(projectID, "pane.resize", daemon.ResizePaneRequest{PaneID: paneID, ClientID: clientID, Cols: uint16(cols), Rows: uint16(rows)}, &struct{}{}); err != nil {
				return err
			}
		case <-poll.C:
			var streamed daemon.ReadPaneOutputResponse
			if err := client.requestForProject(projectID, "pane.output", daemon.ReadPaneOutputRequest{PaneID: paneID, ClientID: clientID, FromSequence: nextSequence}, &streamed); err != nil {
				return err
			}
			for _, chunk := range streamed.Outputs {
				if chunk.Sequence < nextSequence {
					continue
				}
				nextSequence = chunk.Sequence + 1
				if _, err := output.Write(chunk.Data); err != nil {
					return fmt.Errorf("write mux output: %w", err)
				}
			}
		}
	}
}

func readTerminalInput(input io.Reader, chunks chan<- []byte, result chan<- error) {
	buffer := make([]byte, 4096)
	for {
		n, err := input.Read(buffer)
		if n > 0 {
			chunks <- append([]byte(nil), buffer[:n]...)
		}
		if err != nil {
			result <- err
			return
		}
	}
}

// Ctrl-B d is the explicit fallback detach chord. A bare Ctrl-B is preserved
// for programs such as vim; it is only held until the immediately following
// input byte establishes whether the user requested detach.
func splitDetachChord(input []byte, pending *bool) ([]byte, bool) {
	forward := make([]byte, 0, len(input)+1)
	for _, value := range input {
		if *pending {
			*pending = false
			if value == 'd' {
				return forward, true
			}
			forward = append(forward, 0x02)
		}
		if value == 0x02 {
			*pending = true
			continue
		}
		forward = append(forward, value)
	}
	return forward, false
}

func defaultHome() string {
	if configured := os.Getenv("COCKPIT_MUX_HOME"); configured != "" {
		return configured
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".agent-cockpit/mux"
	}
	return filepath.Join(home, ".agent-cockpit", "mux")
}
