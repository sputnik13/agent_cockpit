//go:build libghostty

package daemon

import (
	"bytes"
	"net"
	"testing"
	"time"

	"github.com/local-repo-explorer/cockpit-mux/protocol"
)

// TestFixtureClientReconnectsAcrossSeedBarrier exercises the M1A path solely
// through the Unix socket. It deliberately destroys the first fixture client,
// not the daemon-owned pane, then reattaches at a different geometry. The second
// client imports the received seed into a fresh Ghostty terminal and consumes
// only output at or after the response's resume barrier.
func TestFixtureClientReconnectsAcrossSeedBarrier(t *testing.T) {
	operations := NewOperations()
	home, stop := startTestServer(t, operations.Handle)
	defer stop()
	t.Cleanup(func() {
		operations.mu.Lock()
		session := operations.session
		operations.mu.Unlock()
		if session != nil {
			_, _ = operations.destroy(DestroySessionRequest{SessionID: session.id})
		}
	})

	first := dialFixtureClient(t, home)
	writeOperation(t, first, 1, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh",
		Args:    []string{"-c", "printf 'primary history\\r\\n\\033[?1049h\\033[?2004halt-screen\\r\\n'; while IFS= read -r line; do case \"$line\" in leave-alt) printf '\\033[?1049lprimary-restored\\r\\n' ;; *) ( sleep 0.02; printf 'live:race-during-seed\\r\\n' ) & ;; esac; done"},
	})
	created := fixtureResponse(t, first)
	if created.Error != "" {
		t.Fatalf("session.create error = %q", created.Error)
	}
	var create CreateSessionResponse
	decodeResponse(t, created.Data, &create)

	awaitFixtureOutput(t, first, create.PaneID, 1, []byte("alt-screen"))
	firstAttach := attachFixture(t, first, create.SessionID, 80, 24)
	if firstAttach.ResumeSequence == 0 {
		t.Fatal("initial attach did not return a resume barrier")
	}
	if !bytes.Contains(firstAttach.Seed, []byte("alt-screen")) {
		t.Fatalf("initial seed %q does not contain alternate screen", firstAttach.Seed)
	}

	// Fixture-client exit is an implicit detach. The socket close must not tear down
	// the session's PTY or shadow state.
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}

	second := dialFixtureClient(t, home)
	defer second.Close()
	reattach := attachFixture(t, second, create.SessionID, 100, 32)
	if reattach.ResumeSequence < firstAttach.ResumeSequence {
		t.Fatalf("reattach barrier = %d, initial barrier = %d", reattach.ResumeSequence, firstAttach.ResumeSequence)
	}
	modePrefix := []byte("\x1b[?1049h\x1b[?2004h")
	if !bytes.Contains(reattach.Seed, modePrefix) {
		t.Fatalf("reattach seed missing mode prefix: %q", reattach.Seed)
	}

	// The received socket seed, not a server-side helper, must reconstruct the
	// formatter-visible shadow state at the new attach geometry.
	consumer, err := NewShadow(100, 32)
	if err != nil {
		t.Fatal(err)
	}
	defer consumer.Close()
	consumer.Feed(reattach.Seed)
	gotSeed, err := consumer.Seed()
	if err != nil {
		t.Fatal(err)
	}
	wantSeed := authoritativeSeed(t, operations)
	if !bytes.Equal(gotSeed, wantSeed) {
		t.Fatalf("fresh Ghostty seed differs from authoritative shadow\n got: %q\nwant: %q", gotSeed, wantSeed)
	}

	writeOperation(t, second, 4, methodPaneWrite, WritePaneRequest{
		PaneID: create.PaneID,
		// Arrange output to race the next attach seed. It must appear exactly
		// once, either in that seed or in the post-barrier raw stream.
		Data: []byte("trigger\n"),
	})
	wrote := fixtureResponse(t, second)
	if wrote.Error != "" {
		t.Fatalf("pane.write error = %q", wrote.Error)
	}

	racingAttach := attachFixture(t, second, create.SessionID, 100, 32)
	live := awaitFixtureOutput(t, second, create.PaneID, racingAttach.ResumeSequence, []byte("live:race-during-seed"))
	for _, output := range live.Outputs {
		if output.Sequence < racingAttach.ResumeSequence {
			t.Fatalf("received pre-barrier output %#v for resume %d", output, racingAttach.ResumeSequence)
		}
		consumer.Feed(output.Data)
	}
	canonical, err := consumer.Seed()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(canonical, []byte("live:race-during-seed")) {
		t.Fatalf("post-barrier output missing from reattached Ghostty state: %q", canonical)
	}
	if occurrences := bytes.Count(canonical, []byte("live:race-during-seed")); occurrences != 1 {
		t.Fatalf("post-barrier output occurrences = %d, want exactly one; state=%q", occurrences, canonical)
	}

	writeOperation(t, second, 5, methodPaneWrite, WritePaneRequest{PaneID: create.PaneID, Data: []byte("leave-alt\n")})
	if response := fixtureResponse(t, second); response.Error != "" {
		t.Fatalf("leave alternate screen error = %q", response.Error)
	}
	nextSequence := live.Outputs[len(live.Outputs)-1].Sequence + 1
	primary := awaitFixtureOutput(t, second, create.PaneID, nextSequence, []byte("primary-restored"))
	for _, output := range primary.Outputs {
		consumer.Feed(output.Data)
	}
	canonical, err = consumer.Seed()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(canonical, []byte("primary history")) || !bytes.Contains(canonical, []byte("primary-restored")) {
		t.Fatalf("alternate-screen exit did not restore primary screen: %q", canonical)
	}

	writeOperation(t, second, 6, methodSessionDestroy, DestroySessionRequest{SessionID: create.SessionID})
	destroyed := fixtureResponse(t, second)
	if destroyed.Error != "" {
		t.Fatalf("session.destroy error = %q", destroyed.Error)
	}
}

func dialFixtureClient(t *testing.T, home Home) *net.UnixConn {
	t.Helper()
	connection := dialTestClient(t, home)
	writeHello(t, connection)
	return connection
}

func fixtureResponse(t *testing.T, connection *net.UnixConn) protocol.Response {
	t.Helper()
	var response protocol.Response
	readOperationResponse(t, connection, &response)
	return response
}

func attachFixture(t *testing.T, connection *net.UnixConn, sessionID string, cols, rows uint16) AttachSessionResponse {
	t.Helper()
	writeOperation(t, connection, 2, methodSessionAttach, AttachSessionRequest{
		SessionID: sessionID,
		Cols:      cols,
		Rows:      rows,
	})
	response := fixtureResponse(t, connection)
	if response.Error != "" {
		t.Fatalf("session.attach error = %q", response.Error)
	}
	var attach AttachSessionResponse
	decodeResponse(t, response.Data, &attach)
	return attach
}

func awaitFixtureOutput(t *testing.T, connection *net.UnixConn, paneID string, from uint64, needle []byte) ReadPaneOutputResponse {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		writeOperation(t, connection, 3, methodPaneOutput, ReadPaneOutputRequest{
			PaneID:       paneID,
			FromSequence: from,
		})
		response := fixtureResponse(t, connection)
		if response.Error != "" {
			t.Fatalf("pane.output error = %q", response.Error)
		}
		var output ReadPaneOutputResponse
		decodeResponse(t, response.Data, &output)
		var combined []byte
		for _, chunk := range output.Outputs {
			combined = append(combined, chunk.Data...)
		}
		if bytes.Contains(combined, needle) {
			return output
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %q from sequence %d", needle, from)
	return ReadPaneOutputResponse{}
}

func authoritativeSeed(t *testing.T, operations *Operations) []byte {
	t.Helper()
	operations.mu.Lock()
	defer operations.mu.Unlock()
	attachment, ok := operations.session.attachment.(*shadowAttachment)
	if !ok {
		t.Fatal("native socket session did not own a Ghostty attachment")
	}
	attachment.pipeline.mu.Lock()
	defer attachment.pipeline.mu.Unlock()
	seed, err := attachment.pipeline.Shadow.Seed()
	if err != nil {
		t.Fatal(err)
	}
	return seed
}
