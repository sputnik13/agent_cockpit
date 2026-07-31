import { ImagePaneBody } from './ImagePaneBody';
import { useImageBytes } from './useImageBytes';

interface ImageViewProps {
  worktreePath: string;
  filePath: string;
}

/**
 * Image "Rendered" mode: the current (working-tree) image alone, sized to
 * fit the panel — a single view, not a two-pane compare (that's ImageCompare,
 * the Diff mode). Shares `useImageBytes`/`ImagePaneBody` with ImageCompare's
 * "after" pane so the fetch + MIME + per-state rendering logic lives in
 * exactly one place (see useImageBytes.ts's doc comment).
 */
export function ImageView({ worktreePath, filePath }: ImageViewProps): JSX.Element {
  const state = useImageBytes(filePath, worktreePath);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        padding: 12,
        overflow: 'auto',
      }}
    >
      <ImagePaneBody state={state} alt={filePath} />
    </div>
  );
}
