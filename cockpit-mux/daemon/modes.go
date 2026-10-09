package daemon

import (
	"strconv"
	"strings"

	"github.com/vmihailenco/msgpack/v5"
)

// ModeState holds the terminal state that a VT formatter does not include in its
// screen dump. It retains an unfinished sequence between PTY reads, so a mode
// transition cannot be lost at a read boundary.
type ModeState struct {
	AlternateScreen bool
	BracketedPaste  bool

	privateModes map[int]bool
	insertMode   bool
	scrollRegion string
	cursorShape  string
	keypadApp    bool
	title        string
	kittyFlags   string
	kittyStack   []string
	pending      []byte
	savedCursor  bool
}

// PersistedModeState is the formatter-external portion of an attach seed. It
// deliberately excludes parser carry-over: Snapshot v1 retains that state, while
// a recovered dead pane never accepts further application output.
type PersistedModeState struct {
	AlternateScreen bool         `msgpack:"alternate_screen"`
	BracketedPaste  bool         `msgpack:"bracketed_paste"`
	PrivateModes    map[int]bool `msgpack:"private_modes"`
	InsertMode      bool         `msgpack:"insert_mode"`
	ScrollRegion    string       `msgpack:"scroll_region"`
	CursorShape     string       `msgpack:"cursor_shape"`
	KeypadApp       bool         `msgpack:"keypad_app"`
	Title           string       `msgpack:"title"`
	KittyFlags      string       `msgpack:"kitty_flags"`
	KittyStack      []string     `msgpack:"kitty_stack"`
	SavedCursor     bool         `msgpack:"saved_cursor"`
}

func (modes ModeState) MarshalPersistence() ([]byte, error) {
	privateModes := make(map[int]bool, len(modes.privateModes))
	for mode, enabled := range modes.privateModes {
		privateModes[mode] = enabled
	}
	return msgpack.Marshal(PersistedModeState{
		AlternateScreen: modes.AlternateScreen, BracketedPaste: modes.BracketedPaste,
		PrivateModes: privateModes, InsertMode: modes.insertMode, ScrollRegion: modes.scrollRegion,
		CursorShape: modes.cursorShape, KeypadApp: modes.keypadApp, Title: modes.title,
		KittyFlags: modes.kittyFlags, KittyStack: append([]string(nil), modes.kittyStack...),
		SavedCursor: modes.savedCursor,
	})
}

func RestoreModeState(data []byte) (ModeState, error) {
	var persisted PersistedModeState
	if err := msgpack.Unmarshal(data, &persisted); err != nil {
		return ModeState{}, err
	}
	return ModeState{AlternateScreen: persisted.AlternateScreen, BracketedPaste: persisted.BracketedPaste,
		privateModes: persisted.PrivateModes, insertMode: persisted.InsertMode, scrollRegion: persisted.ScrollRegion,
		cursorShape: persisted.CursorShape, keypadApp: persisted.KeypadApp, title: persisted.Title,
		kittyFlags: persisted.KittyFlags, kittyStack: append([]string(nil), persisted.KittyStack...), savedCursor: persisted.SavedCursor}, nil
}

// Observe records mode and title changes from raw PTY output. Raw bytes are still
// forwarded unchanged; this parser is solely the warm attach-time shadow.
func (modes *ModeState) Observe(data []byte) {
	data = append(append([]byte(nil), modes.pending...), data...)
	modes.pending = nil
	for index := 0; index < len(data); {
		if data[index] != '\x1b' {
			index++
			continue
		}
		if index+1 == len(data) {
			modes.pending = append([]byte(nil), data[index:]...)
			return
		}
		switch data[index+1] {
		case '[':
			final := index + 2
			for final < len(data) && (data[final] < 0x40 || data[final] > 0x7e) {
				final++
			}
			if final == len(data) {
				modes.keepPending(data[index:])
				return
			}
			modes.observeCSI(string(data[index+2:final]), data[final])
			index = final + 1
		case ']':
			end, terminated := oscEnd(data, index+2)
			if !terminated {
				modes.keepPending(data[index:])
				return
			}
			modes.observeOSC(string(data[index+2 : end]))
			if data[end] == '\a' {
				index = end + 1
			} else {
				index = end + 2
			}
		case '=':
			modes.keypadApp = true
			index += 2
		case '>':
			modes.keypadApp = false
			index += 2
		case '7':
			modes.savedCursor = true
			index += 2
		case 'c':
			modes.savedCursor = false
			index += 2
		default:
			index += 2
		}
	}
}

func (modes ModeState) HasSavedCursor() bool { return modes.savedCursor }

func (modes *ModeState) keepPending(data []byte) {
	// A legitimate OSC can be long, but M1A only needs the title. Bound retained
	// incomplete bytes so hostile/non-terminating output cannot grow memory forever.
	const maxPendingBytes = 16 << 10
	if len(data) > maxPendingBytes {
		data = data[len(data)-maxPendingBytes:]
	}
	modes.pending = append([]byte(nil), data...)
}

func oscEnd(data []byte, start int) (int, bool) {
	for index := start; index < len(data); index++ {
		if data[index] == '\a' {
			return index, true
		}
		if data[index] == '\x1b' && index+1 < len(data) && data[index+1] == '\\' {
			return index, true
		}
	}
	return 0, false
}

func (modes *ModeState) observeCSI(params string, final byte) {
	if final == 'u' {
		modes.observeKittyKeyboard(params)
		return
	}
	if final == 'r' && !strings.HasPrefix(params, "?") {
		modes.scrollRegion = params
		return
	}
	if final == 'q' && strings.HasSuffix(params, " ") {
		modes.cursorShape = params
		return
	}
	if final != 'h' && final != 'l' {
		return
	}
	enabled := final == 'h'
	if strings.HasPrefix(params, "?") {
		for _, parameter := range strings.Split(strings.TrimPrefix(params, "?"), ";") {
			mode, err := strconv.Atoi(parameter)
			if err == nil {
				modes.setPrivate(mode, enabled)
			}
		}
		return
	}
	for _, parameter := range strings.Split(params, ";") {
		if parameter == "4" {
			modes.insertMode = enabled
		}
	}
}

func (modes *ModeState) setPrivate(mode int, enabled bool) {
	if modes.privateModes == nil {
		modes.privateModes = make(map[int]bool)
	}
	modes.privateModes[mode] = enabled
	switch mode {
	case 1049:
		modes.AlternateScreen = enabled
	case 2004:
		modes.BracketedPaste = enabled
	}
}

func (modes *ModeState) observeKittyKeyboard(params string) {
	if params == "" {
		return
	}
	switch params[0] {
	case '>':
		modes.kittyStack = append(modes.kittyStack, modes.kittyFlags)
		modes.kittyFlags = strings.TrimPrefix(params, ">")
	case '=':
		modes.kittyFlags = strings.TrimPrefix(params, "=")
	case '<':
		count, err := strconv.Atoi(strings.TrimPrefix(params, "<"))
		if err != nil || count < 1 {
			count = 1
		}
		for ; count > 0 && len(modes.kittyStack) > 0; count-- {
			modes.kittyFlags = modes.kittyStack[len(modes.kittyStack)-1]
			modes.kittyStack = modes.kittyStack[:len(modes.kittyStack)-1]
		}
	}
}

func (modes *ModeState) observeOSC(payload string) {
	separator := strings.IndexByte(payload, ';')
	if separator < 0 {
		return
	}
	if code := payload[:separator]; code == "0" || code == "2" {
		modes.title = payload[separator+1:]
	}
}

// Prefix restores known non-screen state before the formatter seed. Synchronized
// output is always disabled: a client must never attach into a frozen frame.
func (modes ModeState) Prefix() []byte {
	var prefix []byte
	appendPrivate := func(mode int, enabled bool) {
		state := byte('l')
		if enabled {
			state = 'h'
		}
		prefix = append(prefix, "\x1b[?"...)
		prefix = strconv.AppendInt(prefix, int64(mode), 10)
		prefix = append(prefix, state)
	}
	if modes.AlternateScreen {
		appendPrivate(1049, true)
	}
	for _, mode := range []int{1, 5, 6, 7, 25, 1000, 1002, 1003, 1004, 1006, 2004} {
		enabled, known := modes.privateModes[mode]
		if !known {
			continue
		}
		// A fresh terminal already has the default false state for the listed
		// modes except autowrap and cursor visibility; emit resets only for those.
		if !enabled && mode != 7 && mode != 25 {
			continue
		}
		appendPrivate(mode, enabled)
	}
	if modes.insertMode {
		prefix = append(prefix, "\x1b[4h"...)
	}
	if modes.scrollRegion != "" {
		prefix = append(prefix, "\x1b["...)
		prefix = append(prefix, modes.scrollRegion...)
		prefix = append(prefix, 'r')
	}
	if modes.cursorShape != "" {
		prefix = append(prefix, "\x1b["...)
		prefix = append(prefix, modes.cursorShape...)
		prefix = append(prefix, 'q')
	}
	if modes.keypadApp {
		prefix = append(prefix, "\x1b="...)
	}
	if modes.kittyFlags != "" {
		prefix = append(prefix, "\x1b[="...)
		prefix = append(prefix, modes.kittyFlags...)
		prefix = append(prefix, 'u')
	}
	if modes.title != "" {
		prefix = append(prefix, "\x1b]2;"...)
		prefix = append(prefix, modes.title...)
		prefix = append(prefix, '\a')
	}
	prefix = append(prefix, "\x1b[?2026l"...)
	return prefix
}
