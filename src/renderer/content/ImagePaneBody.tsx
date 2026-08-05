import { fmtImageSize, type ImagePaneState } from './useImageBytes';

/**
 * Renders one {@link ImagePaneState} — the shared per-state presentation used
 * by BOTH ImageCompare's panes (before AND after — local_repo_explorer-bn8a
 * gave the "before" pane a real git-`ref` byte source too, so it shares this
 * component and every state exactly like the "after" pane always has) and the
 * single-image ImageView, so the loading/absent/too-large/unreadable messages
 * exist in exactly one place. The caller supplies the surrounding box
 * (ImageCompare's two-pane layout vs ImageView's single full-panel layout);
 * this component only renders the box's CONTENTS.
 *
 * SECURITY (script-inert rendering): the `'shown'` case is the only path that
 * touches the DOM with file-derived content, and it does so EXCLUSIVELY via
 * `<img src=...>` — never `dangerouslySetInnerHTML`, never an iframe. This is
 * the one sink every image extension (including SVG, whose bytes are
 * literally XML/script-capable text) goes through; the browser's own <img>
 * decoder treats the bytes as a raster/vector image, not as document markup,
 * regardless of extension.
 */
export function ImagePaneBody({ state, alt }: { state: ImagePaneState; alt: string }): JSX.Element {
  switch (state.kind) {
    case 'loading':
      return <span style={{ color: 'var(--fg-dim)' }}>Loading…</span>;
    case 'shown':
      return <img src={state.url} alt={alt} style={{ maxWidth: '100%', maxHeight: '100%' }} />;
    case 'absent':
      return <span style={{ color: 'var(--fg-dim)' }}>Not present in the working tree.</span>;
    case 'too-large':
      return (
        <span style={{ color: 'var(--fg-dim)', textAlign: 'center' }}>
          Image too large to preview ({fmtImageSize(state.sizeBytes)}). Use Download (row context menu) to save it
          locally.
        </span>
      );
    case 'unreadable':
      return <span style={{ color: 'var(--fg-dim)' }}>Unable to preview this image.</span>;
  }
}
