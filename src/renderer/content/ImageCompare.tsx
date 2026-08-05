import { ImagePaneBody } from './ImagePaneBody';
import { useImageBytes, type ImagePaneState } from './useImageBytes';

interface ImageCompareProps {
  worktreePath: string;
  baseline: string;
  filePath: string;
  oldPath?: string | null;
}

/**
 * Image "Diff" mode: the before/after visual compare.
 *
 * BASELINE-SIDE DECISION — HISTORY (settled by
 * local_repo_explorer-content-mode-uniform-diff-rendered-sx0i.4; lifted by
 * local_repo_explorer-bn8a — do not re-litigate either decision): `.1`
 * shipped `readFileBytes` with NO git-`ref` support in v1, so `.4` made the
 * "before" (baseline) pane an explicit, hardcoded `'no-baseline-preview'`
 * state rather than attempting a read that could not succeed. `bn8a` lifted
 * that constraint — `readFileBytes` now supports `ref` on both transports
 * (local: `simpleGit.binaryCatFile`; remote: the helper's dedicated
 * `readFileBytes` RPC, never SFTP or the text-only `readFile` RPC) — so the
 * "before" pane now shares `useImageBytes`/`ImagePaneBody` with the "after"
 * pane exactly, passing `{ ref: baseline }` instead of being hardcoded. A
 * path absent at the baseline ref (an added file) resolves to the SAME
 * `'absent'` state a deleted working-tree file already used — no new state,
 * never faked from the working-tree image.
 *
 * `previousPath` (`oldPath ?? filePath`) is the path the "before" pane reads
 * (a rename's OLD name, so the baseline read targets where the content
 * actually lived) and what the "Before" label surfaces.
 */
export function ImageCompare({ worktreePath, baseline, filePath, oldPath }: ImageCompareProps): JSX.Element {
  const previousPath = oldPath ?? filePath;
  const after = useImageBytes(filePath, worktreePath);
  const before = useImageBytes(previousPath, worktreePath, { ref: baseline });

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
  state: ImagePaneState;
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
