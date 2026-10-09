//go:build libghostty

package main

import (
	"bytes"
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/creack/pty"
	"github.com/local-repo-explorer/cockpit-mux/daemon"
	"github.com/local-repo-explorer/cockpit-mux/protocol"
	"github.com/vmihailenco/msgpack/v5"
)

func TestAttachMuxSessionUsesTTYAndDetachChord(t *testing.T) {
	root, err := os.MkdirTemp("/tmp", "cmux-attach-")
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
	create, err := msgpack.Marshal(daemon.CreateSessionRequest{Command: "/bin/sh", Args: []string{"-c", "printf fallback-seed; sleep 30"}, Key: "fallback-attach"})
	if err != nil {
		t.Fatal(err)
	}
	if err := protocol.Write(connection, protocol.Request{ID: 1, Method: "session.create", ProjectID: "project-a", Data: create}); err != nil {
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
	awaitMuxOutputForProject(t, socket, "project-a", created.PaneID, []byte("fallback-seed"))

	master, terminal, err := pty.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer master.Close()
	defer terminal.Close()
	if err := pty.Setsize(terminal, &pty.Winsize{Cols: 100, Rows: 32}); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	attached := make(chan error, 1)
	go func() { attached <- attachMuxSession(socket, "", "", terminal, &output) }()

	time.Sleep(50 * time.Millisecond)
	if _, err := master.Write([]byte{0x02, 'd'}); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-attached:
		if err != nil {
			t.Fatalf("fallback attach: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("fallback attach did not detach on Ctrl-B d")
	}
	if !bytes.Contains(output.Bytes(), []byte("fallback-seed")) {
		t.Fatalf("fallback attach output = %q, want seed", output.String())
	}
	cancel()
	if err := <-done; err != nil && !errors.Is(err, context.Canceled) {
		t.Fatalf("daemon shutdown: %v", err)
	}
}
