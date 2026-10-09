//go:build libghostty

package daemon

import (
	"bytes"
	"fmt"
	"strings"
	"testing"
)

func TestShadowFeedsFormatsAndReportsGroundState(t *testing.T) {
	shadow, err := NewShadow(80, 24)
	if err != nil {
		t.Fatalf("NewShadow() error = %v", err)
	}
	defer shadow.Close()

	shadow.Feed([]byte("primary history\\r\\n\\x1b[?1049halt screen"))
	ground, err := shadow.Ground()
	if err != nil {
		t.Fatalf("Ground() error = %v", err)
	}
	if !ground {
		t.Fatal("shadow parser is not grounded after complete VT input")
	}
	seed, err := shadow.Seed()
	if err != nil {
		t.Fatalf("Seed() error = %v", err)
	}
	if !bytes.Contains(seed, []byte("alt screen")) {
		t.Fatalf("seed %q does not contain rendered alternate screen", seed)
	}
}

func TestShadowScrollbackReturnsStyledRunsWithoutChangingState(t *testing.T) {
	shadow, err := NewShadow(20, 2)
	if err != nil {
		t.Fatal(err)
	}
	defer shadow.Close()
	shadow.Feed([]byte("first\r\n\x1b[1;31mred\x1b[0m\r\nthird\r\nfourth"))

	lines, err := shadow.Scrollback(0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 2 {
		t.Fatalf("history lines = %#v, want two", lines)
	}
	if len(lines[1].Runs) != 1 || lines[1].Runs[0].Text != "red" {
		t.Fatalf("styled history runs = %#v", lines[1].Runs)
	}
	if lines[1].Runs[0].SGR != "1;38;5;1" {
		t.Fatalf("red run SGR = %q, want 1;38;5;1", lines[1].Runs[0].SGR)
	}
	seed, err := shadow.Seed()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(seed, []byte("third")) {
		t.Fatalf("scrollback query changed active terminal state: %q", seed)
	}
}

func TestShadowAppliesFiniteScrollbackTargetToExistingTerminal(t *testing.T) {
	shadow, err := NewShadowWithScrollback(20, 2, 12_345)
	if err != nil {
		t.Fatal(err)
	}
	defer shadow.Close()
	if err := shadow.SetScrollbackLines(1_234); err != nil {
		t.Fatalf("SetScrollbackLines() error = %v", err)
	}
	shadow.mu.Lock()
	limit, err := shadow.terminal.ScrollbackMaxLines()
	shadow.mu.Unlock()
	if err != nil {
		t.Fatalf("ScrollbackMaxLines() error = %v", err)
	}
	if limit == nil || *limit != 1_234 {
		t.Fatalf("live scrollback target = %v, want 1234", limit)
	}
	if err := shadow.SetScrollbackLines(0); err == nil {
		t.Fatal("SetScrollbackLines(0) unexpectedly succeeded")
	}
}

func TestPipelineScrollbackUsesPrimaryHistoryDuringAlternateScreen(t *testing.T) {
	active, err := NewShadow(40, 2)
	if err != nil {
		t.Fatal(err)
	}
	defer active.Close()
	primary, err := NewShadow(40, 2)
	if err != nil {
		t.Fatal(err)
	}
	defer primary.Close()
	primary.Feed([]byte("first\r\nprimary-marker\r\nthird\r\nfourth"))
	active.Feed([]byte("\x1b[?1049halt-screen"))

	lines, err := (&Pipeline{
		Shadow:  active,
		Primary: primary,
		Modes:   ModeState{AlternateScreen: true},
	}).Scrollback(0, 10)
	if err != nil {
		t.Fatal(err)
	}
	var text bytes.Buffer
	for _, line := range lines {
		for _, run := range line.Runs {
			text.WriteString(run.Text)
		}
	}
	if !bytes.Contains(text.Bytes(), []byte("primary-marker")) {
		t.Fatalf("primary history = %q, want primary marker", text.String())
	}
}

func TestFormatterSeedDoesNotClearPreviouslyRestoredScrollback(t *testing.T) {
	producer, err := NewShadow(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer producer.Close()
	producer.Feed([]byte("cockpit-mux-history-marker\r\n"))
	for i := 0; i < 80; i++ {
		producer.Feed([]byte(fmt.Sprintf("tail-%d\r\n", i)))
	}
	history, err := producer.Scrollback(0, 1_000)
	if err != nil {
		t.Fatal(err)
	}
	seed, err := producer.Seed()
	if err != nil {
		t.Fatal(err)
	}

	consumer, err := NewShadow(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer consumer.Close()
	for _, line := range history {
		for _, run := range line.Runs {
			consumer.Feed([]byte(run.Text))
		}
		consumer.Feed([]byte("\r\n"))
	}
	consumer.Feed(seed)
	restored, err := consumer.Scrollback(0, 1_000)
	if err != nil {
		t.Fatal(err)
	}
	var text bytes.Buffer
	for _, line := range restored {
		for _, run := range line.Runs {
			text.WriteString(run.Text)
		}
	}
	if !strings.Contains(text.String(), "cockpit-mux-history-marker") {
		t.Fatalf("formatter seed erased restored history: %q", text.String())
	}
}
