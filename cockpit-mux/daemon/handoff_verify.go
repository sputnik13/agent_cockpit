//go:build libghostty

package daemon

import (
	"fmt"

	"github.com/vmihailenco/msgpack/v5"
)

// VerifyHandoffManifest proves that this daemon's libghostty build can import
// every supplied Snapshot v1 before the old daemon releases a master descriptor.
func VerifyHandoffManifest(manifest HandoffManifest) error {
	if err := manifest.validate(); err != nil {
		return err
	}
	engineVersion, err := EngineVersion()
	if err != nil {
		return err
	}
	if manifest.EngineVersion != engineVersion {
		return fmt.Errorf("incompatible mux handoff engine %q (expected %q)", manifest.EngineVersion, engineVersion)
	}
	for _, pane := range manifest.Panes {
		shadow, err := RestoreShadow(pane.Snapshot)
		if err != nil {
			return fmt.Errorf("import mux handoff pane %s: %w", pane.PaneID, err)
		}
		shadow.Close()
		if len(pane.PrimarySnapshot) == 0 || len(pane.Metadata) == 0 {
			return fmt.Errorf("incomplete mux handoff pane %s", pane.PaneID)
		}
		primary, err := RestoreShadow(pane.PrimarySnapshot)
		if err != nil {
			return fmt.Errorf("import mux handoff primary pane %s: %w", pane.PaneID, err)
		}
		primary.Close()
		var metadata recoveryMetadata
		if err := msgpack.Unmarshal(pane.Metadata, &metadata); err != nil {
			return fmt.Errorf("decode mux handoff metadata for pane %s: %w", pane.PaneID, err)
		}
		if _, err := RestoreModeState(metadata.Modes); err != nil {
			return fmt.Errorf("import mux handoff metadata for pane %s: %w", pane.PaneID, err)
		}
	}
	return nil
}
