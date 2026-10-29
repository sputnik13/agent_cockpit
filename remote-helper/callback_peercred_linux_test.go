//go:build linux

package main

import (
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// These tests exercise the real SO_PEERCRED syscall, so they only exist (and run)
// on Linux. On other hosts the code is compile-checked with GOOS=linux.

func TestPeerUIDReadsTheRealCredentials(t *testing.T) {
	sock := filepath.Join(shortDir(t), "p.sock")
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: sock, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	accepted := make(chan *net.UnixConn, 1)
	go func() {
		conn, err := ln.AcceptUnix()
		if err == nil {
			accepted <- conn
		}
	}()
	client, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	select {
	case server := <-accepted:
		defer server.Close()
		uid, ok := peerUID(server)
		if !ok || int(uid) != os.Geteuid() {
			t.Fatalf("peerUID = %d, %v; want this process's uid %d", uid, ok, os.Geteuid())
		}
		if !defaultPeerAllowed(server) {
			t.Fatal("the same user must be allowed")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no connection accepted")
	}
}

func TestListenerWithTheDefaultPeerCheckServesTheSameUser(t *testing.T) {
	sock := filepath.Join(shortDir(t), "p.sock")
	l, err := startCallbackListener(callbackListenerOptions{socketPath: sock, handle: dispatchedReply})
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	reply, _ := exchange(t, sock, validOpenFrame(t), 2*time.Second)
	if reply["ok"] != true {
		t.Fatalf("reply = %v: the default (SO_PEERCRED) check must admit the helper's own user", reply)
	}
}
