import { useEffect, useState } from 'react';
import { useProjectsStore, useSessionStore, selectStatus } from '../providerClient';
import type { ProjectInfo } from '@shared/ipc/channels';
import type { ConnectionSpec, ConnectionState } from '@shared/providers/types';
import {
  Badge,
  Button,
  Dialog,
  DropdownMenu,
  IconButton,
  StatusDot,
  Tooltip,
  type MenuItemDef,
} from '../ui';
import { useSettingsStore } from '../settings';
import { useWorkspaceControlsStore } from '../workspace/workspaceControlsStore';
import { PANEL_TITLES, PanelIds, type PanelId } from '../workspace/panelIds';
import { COLUMN_RATIOS, PRESET_LABELS, ratioLabel, type PresetName } from '../workspace/presets';

// Maps each connection state to a semantic color tone using the theme CSS-var
// tokens defined in styles.css (--color-added/removed/warn, redefined per theme).
// This makes the tab indicator theme-aware without hardcoding hex colors:
//   connected     → added  (green: --color-added)
//   disconnected  → removed (red: --color-removed)
//   failed        → removed (red: --color-removed)
//   connecting    → warn   (yellow: --color-warn, pulsing)
//   reconnecting  → warn   (yellow: --color-warn, pulsing)
const STATE_TONE: Record<ConnectionState, 'neutral' | 'accent' | 'added' | 'removed' | 'warn'> = {
  disconnected: 'removed',
  connecting: 'warn',
  connected: 'added',
  reconnecting: 'warn',
  failed: 'removed',
};

function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}


/**
 * Compute a unique label for a remote project given the desired base name and
 * the existing project list. If the base name is already taken, disambiguate
 * with `name (user@host)`. If that is also taken, append a counter.
 */
export function remoteProjectLabel(
  base: string,
  user: string,
  host: string,
  existingProjects: readonly Pick<ProjectInfo, 'label'>[],
): string {
  const labels = new Set(existingProjects.map((p) => p.label));
  if (!labels.has(base)) return base;
  const qualified = `${base} (${user}@${host})`;
  if (!labels.has(qualified)) return qualified;
  let n = 2;
  while (labels.has(`${qualified} ${n}`)) n++;
  return `${qualified} ${n}`;
}

/**
 * Top horizontal project switcher. Tabs render in the persistent user order;
 * dragging a tab reorders (and persists) the strip, and the leading number is
 * always the tab's 1-based visual position. ⌘+1..9 (Ctrl off macOS) activates
 * the project at that visual position.
 */
export function ProjectTabs(): JSX.Element {
  const projects = useProjectsStore((s) => s.projects);
  const activeId = useProjectsStore((s) => s.activeId);
  const activate = useProjectsStore((s) => s.activate);
  const add = useProjectsStore((s) => s.add);
  const remove = useProjectsStore((s) => s.remove);
  const update = useProjectsStore((s) => s.update);
  const reorder = useProjectsStore((s) => s.reorder);
  // Workbench controls published by CockpitWorkspace (View/Panels/Reset) — they
  // live here in the single top row but operate on the Dockview workbench.
  const view = useWorkspaceControlsStore((s) => s.view);
  const wsAvailable = useWorkspaceControlsStore((s) => s.available);
  const choosePreset = useWorkspaceControlsStore((s) => s.choosePreset);
  const openPanel = useWorkspaceControlsStore((s) => s.openPanel);
  const resetTo = useWorkspaceControlsStore((s) => s.resetTo);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  /** The remote project currently being edited (null = no edit open). */
  const [editProject, setEditProject] = useState<ProjectInfo | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  async function addLocal(): Promise<void> {
    const path = await window.api.projects.openDialog();
    if (!path) return;
    const project = await add({ label: basename(path), connection: { kind: 'local', rootPath: path } });
    await activate(project.id);
  }

  // ⌘/Ctrl + 1..9 activates the Nth visible tab (left-to-right).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key < '1' || e.key > '9') return;
      const index = Number(e.key) - 1;
      const target = useProjectsStore.getState().projects[index];
      if (!target) return;
      e.preventDefault();
      void useProjectsStore.getState().activate(target.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function onDrop(targetId: string): void {
    if (!dragId || dragId === targetId) return;
    const ids = projects.map((p) => p.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]!);
    setDragId(null);
    void reorder(ids);
  }

  const addMenuItems = [
    { label: 'Local folder…', onSelect: () => void addLocal() },
    { label: 'Remote (SSH)…', onSelect: () => setRemoteOpen(true) },
  ];

  // Workbench control menus. Enabled only when a workbench is mounted for an
  // active project; otherwise the triggers render disabled.
  const wsEnabled = wsAvailable && activeId != null;
  const presetItems: MenuItemDef[] = (Object.keys(PRESET_LABELS) as PresetName[]).map((name) => ({
    label: PRESET_LABELS[name],
    onSelect: () => choosePreset(name),
  }));
  const panelItems: MenuItemDef[] = (Object.values(PanelIds) as PanelId[]).map((id) => ({
    label: PANEL_TITLES[id],
    onSelect: () => openPanel(id),
  }));
  const resetItems: MenuItemDef[] = COLUMN_RATIOS.map((ratio) => ({
    label: `Columns ${ratioLabel(ratio)}`,
    onSelect: () => resetTo(ratio),
  }));

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-edge bg-panel px-2">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {projects.length === 0 ? (
          <span className="px-1 text-xs text-dim">No projects yet — add a local repo or a remote host.</span>
        ) : (
          projects.map((p, i) => (
            <ProjectTab
              key={p.id}
              project={p}
              index={i}
              active={p.id === activeId}
              dragging={dragId === p.id}
              onActivate={() => {
                // Suppress unhandled-rejection noise; activation errors are
                // surfaced via evtStatus (state=failed + detail in status bar).
                void activate(p.id).catch(() => {});
              }}
              onDragStart={() => setDragId(p.id)}
              onDragEnd={() => setDragId(null)}
              onDrop={() => onDrop(p.id)}
            />
          ))
        )}
      </div>
      {/* Workbench controls (operate on the Dockview workspace). */}
      <div className="flex items-center gap-1">
        <DropdownMenu
          trigger={
            <Button size="sm" disabled={!wsEnabled} title="Switch view layout (⌘E / ⌘R)">
              {`View: ${PRESET_LABELS[view]} ▾`}
            </Button>
          }
          items={presetItems}
        />
        <DropdownMenu
          trigger={
            <Button size="sm" disabled={!wsEnabled} title="Reopen a closed panel">
              Panels ▾
            </Button>
          }
          items={panelItems}
        />
        <DropdownMenu
          trigger={
            <Button size="sm" disabled={!wsEnabled} title="Reset layout to a column ratio">
              Reset ▾
            </Button>
          }
          items={resetItems}
        />
      </div>
      {/* Project + app controls. */}
      <div className="flex items-center gap-1">
        <span className="mx-1 h-5 w-px shrink-0 bg-edge" />
        <DropdownMenu
          trigger={
            <Button size="sm" title="Add a project">
              Add project ▾
            </Button>
          }
          items={addMenuItems}
        />
        <Tooltip content="Manage projects">
          <IconButton
            label="Manage projects"
            size="sm"
            disabled={projects.length === 0}
            onClick={() => setManageOpen(true)}
          >
            🗂
          </IconButton>
        </Tooltip>
        <Tooltip content="Diagnostics / logs (⌘⇧L)">
          <IconButton
            label="Diagnostics / logs"
            size="sm"
            onClick={() => void window.api.openDiagnostics()}
          >
            📋
          </IconButton>
        </Tooltip>
        <Tooltip content="Preferences (⌘,)">
          <IconButton
            label="Preferences"
            size="sm"
            onClick={() => useSettingsStore.getState().setOpen(true)}
          >
            ⚙
          </IconButton>
        </Tooltip>
      </div>
      <RemoteAddDialog
        open={remoteOpen}
        onOpenChange={(o) => {
          setRemoteOpen(o);
        }}
        projects={projects}
        onAdd={async (spec, label) => {
          const project = await add({ label, connection: spec });
          setRemoteOpen(false);
          // Activate after closing — if it fails, the project row already exists.
          void activate(project.id).catch(() => {
            // activate failure is surfaced by the session-state UI; do not re-insert.
          });
        }}
      />
      {/* Edit dialog: reuses RemoteAddDialog in edit mode, prefilled from editProject. */}
      <RemoteAddDialog
        open={editProject != null}
        onOpenChange={(o) => { if (!o) setEditProject(null); }}
        projects={projects}
        editTarget={editProject ?? undefined}
        onAdd={async (spec, label) => {
          if (!editProject) return;
          await update(editProject.id, { connection: spec, label });
          setEditProject(null);
        }}
      />
      {/* Keep Manage open behind the edit dialog (onEdit only sets editProject)
          so saving/cancelling the edit returns to the Manage list instead of
          dismissing everything. */}
      <ManageProjectsDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        projects={projects}
        onClose={(id) => remove(id)}
        onEdit={(p) => setEditProject(p)}
      />
    </div>
  );
}

function ProjectTab({
  project,
  index,
  active,
  dragging,
  onActivate,
  onDragStart,
  onDragEnd,
  onDrop,
}: {
  project: ProjectInfo;
  index: number;
  active: boolean;
  dragging: boolean;
  onActivate: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
}): JSX.Element {
  const status = useSessionStore(selectStatus(project.id));
  // Color encodes connection state via theme-aware tokens; text encodes kind.
  // Remote tabs reflect live connection state. Local tabs use 'added' (local is
  // always connected after j49w fix) or 'accent' while the active tab hasn't
  // received a status event yet.
  const tone: 'neutral' | 'accent' | 'added' | 'removed' | 'warn' = status
    ? STATE_TONE[status.state]
    : active
      ? 'accent'
      : 'neutral';
  const kindBadgeTone: 'neutral' | 'accent' | 'added' | 'removed' | 'warn' =
    project.kind === 'remote' ? tone : 'neutral';
  const inFlight = status?.state === 'connecting' || status?.state === 'reconnecting';
  // Full connection detail in the tab tooltip for remote projects.
  const tooltipLabel =
    project.kind === 'remote' && project.connection.kind === 'remote'
      ? `${project.label}  (${project.connection.user}@${project.connection.host}:${project.connection.remotePath})  ⌘${index + 1}`
      : `${project.label}  (⌘${index + 1})`;
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      onClick={onActivate}
      title={tooltipLabel}
      className={[
        'flex h-7 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded border px-2 text-[13px]',
        active
          ? 'border-accent bg-panel-2 text-fg'
          : 'border-transparent text-dim hover:bg-panel-2 hover:text-fg',
        dragging ? 'opacity-50' : '',
      ].join(' ')}
    >
      {/* ⌘-number hint: always the current 1-based visual position. */}
      <span className="font-mono text-[10px] text-dim">{index + 1}</span>
      <StatusDot tone={tone} pulse={inFlight} />
      <span className="max-w-[180px] truncate">{project.label}</span>
      <Badge tone={kindBadgeTone}>{project.kind}</Badge>
    </div>
  );
}

/**
 * Dialog for adding OR editing a remote project. When `editTarget` is
 * provided the dialog is in edit mode: fields are prefilled from the existing
 * connection and the primary button reads "Save" instead of "Add". The label
 * is preserved unchanged on edit (it was already set name-first by the
 * add-time logic or the relabel migration).
 */
function RemoteAddDialog({
  open,
  onOpenChange,
  projects,
  editTarget,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projects: readonly Pick<ProjectInfo, 'label'>[];
  /** Present when the dialog is in edit mode; undefined for add mode. */
  editTarget?: ProjectInfo;
  onAdd: (spec: ConnectionSpec, label: string) => Promise<void>;
}): JSX.Element {
  const isEdit = editTarget != null;
  const existingConn =
    isEdit && editTarget.connection.kind === 'remote' ? editTarget.connection : null;

  const [host, setHost] = useState('');
  const [user, setUser] = useState('');
  const [port, setPort] = useState('22');
  const [remotePath, setRemotePath] = useState('');
  const [busy, setBusy] = useState(false);

  // Populate (or reset) form fields when the dialog opens or the edit target changes.
  useEffect(() => {
    if (open) {
      setHost(existingConn?.host ?? '');
      setUser(existingConn?.user ?? '');
      setPort(String(existingConn?.port ?? 22));
      setRemotePath(existingConn?.remotePath ?? '');
      setBusy(false);
    } else {
      setHost('');
      setUser('');
      setPort('22');
      setRemotePath('');
      setBusy(false);
    }
  // existingConn is derived from editTarget which is stable while the dialog
  // is open; we intentionally only refetch when `open` changes, not on each
  // render tick.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const field =
    'w-full rounded border border-edge bg-bg px-2 py-1 text-[13px] text-fg outline-none focus-visible:border-accent';
  const valid = host.trim() && user.trim() && remotePath.trim();

  async function handleSubmit(): Promise<void> {
    if (!valid || busy) return;
    setBusy(true);
    try {
      // Edit: keep the existing label (already name-first). Add: compute fresh.
      const label = isEdit
        ? editTarget.label
        : remoteProjectLabel(basename(remotePath), user, host, projects);
      await onAdd(
        {
          kind: 'remote',
          host,
          user,
          port: Number(port) || 22,
          remotePath,
          identityPath: existingConn?.identityPath,
        },
        label,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? 'Edit remote project' : 'Add remote project'}
      description="Connect over SSH. The host needs SSH + tmux."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!valid || busy}
            onClick={() => void handleSubmit()}
          >
            {busy ? (isEdit ? 'Saving…' : 'Adding…') : isEdit ? 'Save' : 'Add'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <input className={field} placeholder="host" value={host} onChange={(e) => setHost(e.target.value)} />
        <input className={field} placeholder="user" value={user} onChange={(e) => setUser(e.target.value)} />
        <input className={field} placeholder="port" value={port} onChange={(e) => setPort(e.target.value)} />
        <input
          className={field}
          placeholder="remote repo path"
          value={remotePath}
          onChange={(e) => setRemotePath(e.target.value)}
        />
      </div>
    </Dialog>
  );
}

/**
 * Project management modal. Closing a project lives here (not on the tabs) so a
 * stray click can't drop a project; each row's "Close" requires a deliberate
 * inline confirm before the project is removed. Remote projects also get an
 * Edit affordance that opens the connection form.
 */
function ManageProjectsDialog({
  open,
  onOpenChange,
  projects,
  onClose,
  onEdit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projects: ProjectInfo[];
  onClose: (id: string) => Promise<void> | void;
  /** Called when the user clicks Edit on a remote row; receives the project. */
  onEdit: (project: ProjectInfo) => void;
}): JSX.Element {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Manage projects"
      description="Close projects you're done with. Closing a project doesn't delete any files."
      footer={<Button onClick={() => onOpenChange(false)}>Done</Button>}
    >
      {projects.length === 0 ? (
        <p className="text-xs text-dim">No projects.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {projects.map((p) => (
            <ManageProjectRow
              key={p.id}
              project={p}
              onClose={() => onClose(p.id)}
              onEdit={p.kind === 'remote' ? () => onEdit(p) : undefined}
            />
          ))}
        </ul>
      )}
    </Dialog>
  );
}

function ManageProjectRow({
  project,
  onClose,
  onEdit,
}: {
  project: ProjectInfo;
  onClose: () => void;
  /** Present for remote projects; opens the edit connection dialog. */
  onEdit?: () => void;
}): JSX.Element {
  const status = useSessionStore(selectStatus(project.id));
  const tone = status ? STATE_TONE[status.state] : 'neutral';
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="flex items-center gap-2 rounded border border-edge bg-bg px-2 py-1.5 text-[13px]">
      <StatusDot tone={tone} pulse={status?.state === 'connecting'} />
      <span className="min-w-0 flex-1 truncate">{project.label}</span>
      <Badge tone={project.kind === 'remote' ? 'warn' : 'neutral'}>{project.kind}</Badge>
      {onEdit && !confirming && (
        <Button size="sm" variant="ghost" onClick={onEdit}>
          Edit
        </Button>
      )}
      {confirming ? (
        <>
          <Button size="sm" variant="danger" onClick={onClose}>
            Confirm
          </Button>
          <Button size="sm" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
          Close
        </Button>
      )}
    </li>
  );
}
