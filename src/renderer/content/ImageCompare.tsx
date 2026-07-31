import { ImagePaneBody } from './ImagePaneBody';
import { useImageBytes, type ImageDisplayState } from './useImageBytes';

interface ImageCompareProps {
  worktreePath: string;
  baseline: string;
  filePath: string;
  oldPath?: string | null;
}

/**
 * Image "Diff" mode: the before/after visual compare.
 *
 * BASELINE-SIDE DECISION (settled; recorded on
 * local_repo_explorer-content-mode-uniform-diff-rendered-sx0i.4 as a bead
 * comment — do not re-litigate): `.1`'s `readFileBytes` shipped with NO
 * git-`ref` support in v1 (`FileBytesOptions` has no `ref` field at all, and
 * the IPC handler whitelists only `{ worktreePath }` at the boundary — see
 * `WorkspaceProvider.readFileBytes`'s doc comment in
 * src/shared/providers/types.ts). So the "before" (baseline) pane has NO byte
 * source whatsoever in this version — this is OPTION (A) from the issue's
 * contract: render an explicit, honest `'no-baseline-preview'` state on that
 * side rather than attempting a read that cannot succeed, and never faking it
 * with the working-tree image (that would silently show identical
 * before/after images, which is worse than admitting the gap). The "after"
 * (working-tree) side has a real byte source and genuinely renders via
 * `useImageBytes`/`readFileBytes`.
 *
 * `previousPath` (`oldPath ?? filePath`) is preserved from the pre-existing
 * component's shape (deleted/renamed files keep working the same way for
 * PATH RESOLUTION), even though no read is ever attempted against it now — it
 * still surfaces in the "Before" label so a rename's old name stays visible.
 */
export function ImageCompare({ worktreePath, baseline, filePath, oldPath }: ImageCompareProps): JSX.Element {
  const previousPath = oldPath ?? filePath;
  const after = useImageBytes(filePath, worktreePath);
  const before: ImageDisplayState = { kind: 'no-baseline-preview' };

  return (
    <div style={{ display: 'flex', gap: 12, padding: 12, overflow: 'auto', height: '100%' }}>
      <ImagePane
        label={oldPath ? `Before (baseline) — was ${previousPath}` : `Before (baseline: ${baseline})`}
        state={before}
        alt="Before (baseline)"
      />
      <ImagePane label="After (working tree)" state={after} alt="After (working tree)" />
    </div>
  );
}

function ImagePane({
  label,
  state,
  alt,
}: {
  label: string;
  state: ImageDisplayState;
  alt: string;
}): JSX.Element {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ color: 'var(--fg-dim)', fontSize: 12 }}>{label}</div>
      <div
        style={{
          flex: 1,
          background: 'var(--bg-panel)',
          border: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 8,
          overflow: 'hidden',
        }}
      >
        <ImagePaneBody state={state} alt={alt} />
      </div>
    </div>
  );
}
