//go:build libghostty

package main

import (
	"bytes"
	"context"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/local-repo-explorer/cockpit-mux/daemon"
	"github.com/local-repo-explorer/cockpit-mux/persistence"
	"github.com/local-repo-explorer/cockpit-mux/protocol"
	"github.com/vmihailenco/msgpack/v5"
)

func TestRunContextFinalizesPendingPersistentOutput(t *testing.T) {
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
	connection, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: socket, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if err := protocol.Write(connection, protocol.Hello{Protocol: protocol.Version}); err != nil {
		t.Fatal(err)
	}
	createData, err := msgpack.Marshal(daemon.CreateSessionRequest{Command: "/bin/sh", Args: []string{"-c", "printf final-clean-output; sleep 30"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := protocol.Write(connection, protocol.Request{ID: 1, Method: "session.create", Data: createData}); err != nil {
		t.Fatal(err)
	}
	var response protocol.Response
	if err := protocol.Read(connection, &response); err != nil {
		t.Fatal(err)
	}
	if response.Error != "" {
		t.Fatalf("session.create error = %q", response.Error)
	}
	var created daemon.CreateSessionResponse
	if err := msgpack.Unmarshal(response.Data, &created); err != nil {
		t.Fatal(err)
	}
	seenOutput := false
	for time.Now().Before(deadline) {
		readData, err := msgpack.Marshal(daemon.ReadPaneOutputRequest{PaneID: created.PaneID, FromSequence: 1})
		if err != nil {
			t.Fatal(err)
		}
		if err := protocol.Write(connection, protocol.Request{ID: 2, Method: "pane.output", Data: readData}); err != nil {
			t.Fatal(err)
		}
		if err := protocol.Read(connection, &response); err != nil {
			t.Fatal(err)
		}
		var output daemon.ReadPaneOutputResponse
		if err := msgpack.Unmarshal(response.Data, &output); err != nil {
			t.Fatal(err)
		}
		var all []byte
		for _, chunk := range output.Outputs {
			all = append(all, chunk.Data...)
		}
		if bytes.Contains(all, []byte("final-clean-output")) {
			seenOutput = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !seenOutput {
		t.Fatal("daemon did not deliver the pending output before clean shutdown")
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("daemon shutdown error: %v", err)
	}

	version, err := daemon.EngineVersion()
	if err != nil {
		t.Fatal(err)
	}
	store, err := persistence.Open(filepath.Join(home, "state.db"), persistence.DefaultTailCap*4)
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = store.Load(version)
	if closeErr := store.Close(); closeErr != nil && err == nil {
		err = closeErr
	}
	if err == nil || !strings.Contains(err.Error(), "no rows") {
		t.Fatalf("daemon shutdown retained terminal recovery data: %v", err)
	}
}
