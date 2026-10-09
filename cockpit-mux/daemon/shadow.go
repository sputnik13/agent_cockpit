//go:build libghostty

package daemon

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	ghostty "go.mitchellh.com/libghostty"
)

// Shadow is the authoritative terminal-state path. It is deliberately separate
// from Pane's raw live-byte path: parsing must never delay or rewrite live output.
type Shadow struct {
	mu       sync.Mutex
	terminal *ghostty.Terminal
}

// The forced keyframe ceiling is 4 MiB. A PTY read may cross it by one 32 KiB
// pipeline buffer before Recorder takes the forced snapshot, so the native
// continuation tracker must retain that final chunk too.
const continuationMaxBytes = (4 << 20) + (32 << 10)

//go:embed scrollback-policy.json
var scrollbackPolicyData []byte

var scrollbackPolicy struct {
	MaxLines int `json:"max_lines"`
}

func init() {
	if err := json.Unmarshal(scrollbackPolicyData, &scrollbackPolicy); err != nil || scrollbackPolicy.MaxLines < 1 {
		panic("invalid embedded mux scrollback policy")
	}
}

func NewShadow(cols, rows uint16) (*Shadow, error) {
	return NewShadowWithScrollback(cols, rows, uint(scrollbackPolicy.MaxLines))
}

// NewShadowWithScrollback creates a bounded native terminal state. Ghostty
// prunes history page-by-page, so the limit is a finite target rather than an
// exact row count.
func NewShadowWithScrollback(cols, rows uint16, maxLines uint) (*Shadow, error) {
	if maxLines == 0 {
		maxLines = uint(scrollbackPolicy.MaxLines)
	}
	terminal, err := ghostty.NewTerminal(
		ghostty.WithSize(cols, rows),
		ghostty.WithMaxScrollbackLines(maxLines),
		ghostty.WithContinuationMaxBytes(continuationMaxBytes),
		// Kitty graphics requires a PTY reply callback even when applications
		// request quiet responses. The shadow is one-way state authority: replies
		// belong to the real renderer, never this parser-only mirror.
		ghostty.WithWritePty(func(_ *ghostty.Terminal, _ []byte) {}),
	)
	if err != nil {
		return nil, fmt.Errorf("create Ghostty shadow: %w", err)
	}
	if err := configureKittyGraphics(terminal); err != nil {
		terminal.Close()
		return nil, err
	}
	return &Shadow{terminal: terminal}, nil
}

// SetScrollbackLines applies the finite live-history target to an existing
// terminal. Lowering it may prune native history immediately, at Ghostty's
// page granularity.
func (shadow *Shadow) SetScrollbackLines(maxLines uint) error {
	if maxLines == 0 {
		return fmt.Errorf("mux scrollback line target must be positive")
	}
	shadow.mu.Lock()
	defer shadow.mu.Unlock()
	if err := shadow.terminal.SetScrollbackMaxLines(&maxLines); err != nil {
		return fmt.Errorf("set Ghostty scrollback line target: %w", err)
	}
	return nil
}

func (shadow *Shadow) Feed(data []byte) {
	shadow.mu.Lock()
	defer shadow.mu.Unlock()
	_, _ = shadow.terminal.Write(data)
}

func (shadow *Shadow) Resize(cols, rows uint16) error {
	return shadow.ResizeWithPixels(cols, rows, 0, 0)
}

// ResizeWithPixels keeps the native parser's cell geometry aligned with a
// renderer that knows physical cell dimensions. Kitty PNG placements without
// explicit rows/columns require those dimensions to resolve their viewport
// rectangle; a zero size remains valid for text-only/TTY clients.
func (shadow *Shadow) ResizeWithPixels(cols, rows, cellWidth, cellHeight uint16) error {
	shadow.mu.Lock()
	defer shadow.mu.Unlock()
	if err := shadow.terminal.Resize(cols, rows, uint32(cellWidth), uint32(cellHeight)); err != nil {
		return fmt.Errorf("resize Ghostty shadow: %w", err)
	}
	return nil
}

// Seed returns the formatter-produced VT screen state. M1A's attach layer adds the
// mode-restoration prefix before this payload and uses its sequence barrier after it.
func (shadow *Shadow) Seed() ([]byte, error) {
	shadow.mu.Lock()
	defer shadow.mu.Unlock()
	return formatTerminal(shadow.terminal)
}

// SavedCursorSeed snapshots the terminal, restores DECRC in an isolated clone,
// then formats the clone's now-current state. The caller follows this payload with
// DECSC and the authoritative current seed, preserving every field Ghostty saves.
func (shadow *Shadow) SavedCursorSeed() ([]byte, error) {
	shadow.mu.Lock()
	snapshot, err := shadow.terminal.Snapshot()
	shadow.mu.Unlock()
	if err != nil {
		return nil, fmt.Errorf("snapshot Ghostty shadow: %w", err)
	}
	decoder, err := ghostty.NewSnapshotDecoderBytesCopy(snapshot)
	if err != nil {
		return nil, fmt.Errorf("create Ghostty snapshot decoder: %w", err)
	}
	defer decoder.Close()
	clone, err := decoder.Decode()
	if err != nil {
		return nil, fmt.Errorf("decode Ghostty snapshot: %w", err)
	}
	defer clone.Close()
	clone.VTWrite([]byte("\x1b8"))
	return formatTerminal(clone)
}

func formatTerminal(terminal *ghostty.Terminal) ([]byte, error) {
	formatter, err := ghostty.NewFormatter(terminal,
		ghostty.WithFormatterFormat(ghostty.FormatterFormatVT),
		// The formatter emits authoritative state for the portions that cannot
		// safely be reconstructed from a raw control-stream observer: charset
		// designations/shift, tab stops, scrolling region, current SGR style,
		// cursor position, keypad/application modes, and Kitty keyboard flags.
		// ModeState supplies the small mode prefix the formatter omits on this
		// pinned library revision (notably alternate-screen and paste state).
		ghostty.WithFormatterExtraModes(true),
		ghostty.WithFormatterExtraScrollingRegion(true),
		ghostty.WithFormatterExtraTabstops(true),
		ghostty.WithFormatterExtraKeyboard(true),
		ghostty.WithFormatterExtraCursor(true),
		ghostty.WithFormatterExtraStyle(true),
		ghostty.WithFormatterExtraProtection(true),
		ghostty.WithFormatterExtraKittyKeyboard(true),
		ghostty.WithFormatterExtraCharsets(true),
	)
	if err != nil {
		return nil, fmt.Errorf("create Ghostty formatter: %w", err)
	}
	defer formatter.Close()
	seed, err := formatter.Format()
	if err != nil {
		return nil, fmt.Errorf("format Ghostty seed: %w", err)
	}
	return seed, nil
}

func (shadow *Shadow) Ground() (bool, error) {
	shadow.mu.Lock()
	defer shadow.mu.Unlock()
	ground, err := shadow.terminal.VTGround()
	if err != nil {
		return false, fmt.Errorf("inspect Ghostty parser state: %w", err)
	}
	return ground, nil
}

// Scrollback returns bounded primary-history rows with adjacent equal styles
// coalesced into runs. It never mutates the viewport or terminal state.
func (shadow *Shadow) Scrollback(before, count uint) ([]ScrollbackLine, error) {
	shadow.mu.Lock()
	defer shadow.mu.Unlock()
	total, err := shadow.terminal.ScrollbackRows()
	if err != nil {
		return nil, fmt.Errorf("read Ghostty scrollback size: %w", err)
	}
	if before >= total {
		return nil, nil
	}
	end := total - before
	start := uint(0)
	if count < end {
		start = end - count
	}
	cols, err := shadow.terminal.Cols()
	if err != nil {
		return nil, fmt.Errorf("read Ghostty columns: %w", err)
	}
	lines := make([]ScrollbackLine, 0, end-start)
	for y := start; y < end; y++ {
		line, err := shadow.historyLine(y, cols)
		if err != nil {
			return nil, err
		}
		lines = append(lines, line)
	}
	return lines, nil
}

func (shadow *Shadow) ScrollbackCount() (uint, error) {
	shadow.mu.Lock()
	defer shadow.mu.Unlock()
	count, err := shadow.terminal.ScrollbackRows()
	if err != nil {
		return 0, fmt.Errorf("read Ghostty scrollback size: %w", err)
	}
	return count, nil
}

func (shadow *Shadow) historyLine(y uint, cols uint16) (ScrollbackLine, error) {
	runs := make([]ScrollbackRun, 0, cols)
	for x := uint16(0); x < cols; x++ {
		ref, err := shadow.terminal.GridRef(ghostty.Point{Tag: ghostty.PointTagHistory, X: x, Y: uint32(y)})
		if err != nil {
			return ScrollbackLine{}, fmt.Errorf("read Ghostty history cell: %w", err)
		}
		cell, err := ref.Cell()
		if err != nil {
			return ScrollbackLine{}, fmt.Errorf("read Ghostty history cell data: %w", err)
		}
		wide, err := cell.Wide()
		if err != nil {
			return ScrollbackLine{}, fmt.Errorf("read Ghostty history cell width: %w", err)
		}
		if wide == ghostty.CellWideSpacerTail || wide == ghostty.CellWideSpacerHead {
			continue
		}
		text := " "
		if hasText, err := cell.HasText(); err != nil {
			return ScrollbackLine{}, fmt.Errorf("read Ghostty history cell text flag: %w", err)
		} else if hasText {
			codepoint, err := cell.Codepoint()
			if err != nil {
				return ScrollbackLine{}, fmt.Errorf("read Ghostty history codepoint: %w", err)
			}
			text = string(rune(codepoint))
		}
		style, err := ref.Style()
		if err != nil {
			return ScrollbackLine{}, fmt.Errorf("read Ghostty history style: %w", err)
		}
		sgr := styleSGR(style)
		if len(runs) > 0 && runs[len(runs)-1].SGR == sgr {
			runs[len(runs)-1].Text += text
		} else {
			runs = append(runs, ScrollbackRun{Text: text, SGR: sgr})
		}
	}
	for len(runs) > 0 {
		last := &runs[len(runs)-1]
		last.Text = strings.TrimRight(last.Text, " ")
		if last.Text != "" {
			break
		}
		runs = runs[:len(runs)-1]
	}
	return ScrollbackLine{Line: y, Runs: runs}, nil
}

func styleSGR(style *ghostty.Style) string {
	parts := make([]string, 0, 10)
	if style.Bold() {
		parts = append(parts, "1")
	}
	if style.Faint() {
		parts = append(parts, "2")
	}
	if style.Italic() {
		parts = append(parts, "3")
	}
	switch style.Underline() {
	case ghostty.UnderlineSingle:
		parts = append(parts, "4")
	case ghostty.UnderlineDouble:
		parts = append(parts, "4:2")
	case ghostty.UnderlineCurly:
		parts = append(parts, "4:3")
	case ghostty.UnderlineDotted:
		parts = append(parts, "4:4")
	case ghostty.UnderlineDashed:
		parts = append(parts, "4:5")
	}
	if style.Blink() {
		parts = append(parts, "5")
	}
	if style.Inverse() {
		parts = append(parts, "7")
	}
	if style.Invisible() {
		parts = append(parts, "8")
	}
	if style.Strikethrough() {
		parts = append(parts, "9")
	}
	if style.Overline() {
		parts = append(parts, "53")
	}
	parts = append(parts, colorSGR("38", style.FgColor())...)
	parts = append(parts, colorSGR("48", style.BgColor())...)
	parts = append(parts, colorSGR("58", style.UnderlineColor())...)
	return strings.Join(parts, ";")
}

func colorSGR(prefix string, color ghostty.StyleColor) []string {
	switch color.Tag {
	case ghostty.StyleColorPalette:
		return []string{prefix, "5", fmt.Sprint(color.Palette)}
	case ghostty.StyleColorRGB:
		return []string{prefix, "2", fmt.Sprint(color.RGB.R), fmt.Sprint(color.RGB.G), fmt.Sprint(color.RGB.B)}
	default:
		return nil
	}
}

func (shadow *Shadow) Close() {
	shadow.mu.Lock()
	defer shadow.mu.Unlock()
	shadow.terminal.Close()
}
