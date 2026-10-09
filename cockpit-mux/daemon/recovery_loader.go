//go:build libghostty

package daemon

import (
	"database/sql"
	"errors"

	"github.com/local-repo-explorer/cockpit-mux/persistence"
)

func loadRecoveredSession(path string) (*managedSession, error) {
	store, err := persistence.Open(path, persistence.DefaultTailCap*4)
	if err != nil {
		return nil, err
	}
	defer store.Close()
	version, err := EngineVersion()
	if err != nil {
		return nil, err
	}
	keyframe, tail, err := store.Load(version)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	attachment, err := newRecoveredAttachment(keyframe)
	if err != nil {
		return nil, err
	}
	for _, batch := range tail {
		attachment.shadow.Feed(batch)
		attachment.primaryMirror.Feed(attachment.primary, batch)
		attachment.modes.Observe(batch)
	}
	return &managedSession{
		id: "recovered-session", paneID: "recovered-pane", attachment: attachment, outputHistory: attachment,
	}, nil
}

func loadRecoveredCatalog(path string) ([]*managedSession, error) {
	store, err := persistence.Open(path, persistence.DefaultTailCap*4)
	if err != nil {
		return nil, err
	}
	defer store.Close()
	version, err := EngineVersion()
	if err != nil {
		return nil, err
	}
	panes, err := store.CatalogPanes()
	if err != nil {
		return nil, err
	}
	recovered := make([]*managedSession, 0, len(panes))
	for _, pane := range panes {
		session := &managedSession{
			id: "recovered-" + pane.PaneID, paneID: pane.PaneID, key: pane.Key, projectID: pane.ProjectID,
			logicalSessionID: pane.SessionID, windowID: pane.WindowID,
			broadcast: pane.Broadcast, pinned: pane.Pinned,
		}
		if session.projectID == "" {
			session.projectID = "standalone"
		}
		keyframe, tail, err := store.LoadPane(pane.PaneID, version)
		if err != nil {
			session.recoveryDiagnostic = err.Error()
			recovered = append(recovered, session)
			continue
		}
		attachment, err := newRecoveredAttachment(keyframe)
		if err != nil {
			session.recoveryDiagnostic = err.Error()
			recovered = append(recovered, session)
			continue
		}
		for _, batch := range tail {
			attachment.shadow.Feed(batch)
			attachment.primaryMirror.Feed(attachment.primary, batch)
			attachment.modes.Observe(batch)
		}
		session.attachment = attachment
		session.outputHistory = attachment
		recovered = append(recovered, session)
	}
	return recovered, nil
}
