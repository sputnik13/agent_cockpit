import { useEffect, useState } from 'react';

/**
 * Extension -> MIME map for building an image `data:` URL. Deliberately small
 * and local (mirrors modeSwitcher.tsx's `IMAGE_EXT`): this is the one place
 * that decides which extensions this app can render as an image at all. An
 * extension NOT in this map degrades to the `'unreadable'` pane state — never
 * a `data:` URL with a wrong/missing MIME type, and never byte-content
 * sniffing (out of scope; see the issue's guardrails).
 */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

function extOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot).toLowerCase();
}

/** MIME type for an image path's extension, or `null` when unrecognized. */
export function mimeForImagePath(path: string): string | null {
  return MIME_BY_EXT[extOf(path)] ?? null;
}

/**
 * The renderable state of a single image pane/view — shared by ImageCompare's
 * "before" (baseline, git-`ref` read) AND "after" (working-tree) panes, and
 * the standalone single-image Rendered view (ImageView.tsx). All three fetch
 * bytes via `useImageBytes` below, the "before" pane passing `{ ref }`
 * (local_repo_explorer-bn8a lifted the earlier v1 constraint — `readFileBytes`
 * had no `ref` support, so that pane was hardcoded to a distinct
 * `'no-baseline-preview'` state; see ImageCompare.tsx's doc comment for the
 * history — the state no longer exists).
 *
 * `'absent'` realizes what the issue's contract calls "absent-at-baseline (an
 * added file)": a `ref` read whose path does not exist at that ref (an added
 * file has no baseline version) resolves `{ exists: false, reason: 'missing' }`
 * exactly like a missing working-tree path, so it lands here too — the SAME
 * state, not a separate one. It also still fires for a DELETED file's "after"
 * pane (the mirror image). Named generically (`'absent'`, not
 * `'…-at-baseline'`) because nothing about it is baseline-specific — it is
 * exactly RawFile's `'missing'` case, one level up (image bytes instead of
 * text), and its rendered text ("Not present in the working tree.") is
 * deliberately pane-position-neutral now that either pane can reach it.
 */
export type ImagePaneState =
  | { kind: 'loading' }
  | { kind: 'shown'; url: string }
  | { kind: 'absent' }
  | { kind: 'too-large'; sizeBytes: number }
  | { kind: 'unreadable' };

/**
 * Fetch `path`'s bytes via `window.api.provider.readFileBytes` — the WORKING
 * TREE by default, or AT a git ref when `opts.ref` is supplied (the
 * image-diff baseline preview; local_repo_explorer-bn8a) — and reduce the
 * result to a renderable {@link ImagePaneState}.
 *
 * Byte-to-`<img>` mechanism: builds a `data:` URL rather than a `Blob` +
 * `URL.createObjectURL`. The bytes arrive as base64 already (the IPC reply
 * shape), so `data:<mime>;base64,<bytesBase64>` is a direct, zero-copy string
 * build with no extra Blob/object-URL indirection — and, load-bearingly, a
 * `data:` URL needs NO revocation: there is no browser-held resource to leak,
 * so this hook's cleanup exists ONLY to guard against a stale response
 * landing after `path`/`worktreePath`/`ref` change or unmount (the `active`
 * flag below), never to release anything. Do not add a revocation effect here.
 *
 * Branches on `reason` (never on `bytesBase64` truthiness) per
 * `FileBytesResult`'s documented contract, so a legitimately empty (0-byte)
 * image file is not misread as absent.
 */
export function useImageBytes(path: string, worktreePath: string, opts?: { ref?: string }): ImagePaneState {
  const [state, setState] = useState<ImagePaneState>({ kind: 'loading' });
  const ref = opts?.ref;

  useEffect(() => {
    let active = true;
    setState({ kind: 'loading' });

    const mime = mimeForImagePath(path);
    if (!mime) {
      // Unrecognized extension: never attempt a read that could only ever
      // produce a broken <img> (wrong/missing MIME) — degrade immediately.
      setState({ kind: 'unreadable' });
      return () => {
        active = false;
      };
    }

    void window.api.provider
      .readFileBytes(path, { worktreePath, ref })
      .then((r) => {
        if (!active) return;
        switch (r.reason) {
          case 'too-large':
            setState({ kind: 'too-large', sizeBytes: r.sizeBytes });
            break;
          case 'missing':
            setState({ kind: 'absent' });
            break;
          case 'is-dir':
            // An image path resolving to a directory is not a valid read
            // target — "exists, but not as a file" is `unreadable`, not
            // `absent` (which means "does not exist at all").
            setState({ kind: 'unreadable' });
            break;
          case null:
            // Bytes are present — branch on `reason === null`, never on
            // `bytesBase64` truthiness (an existing 0-byte file yields a
            // legitimately empty, falsy string).
            setState({ kind: 'shown', url: `data:${mime};base64,${r.bytesBase64 ?? ''}` });
            break;
          default:
            setState({ kind: 'unreadable' });
        }
      })
      .catch(() => {
        if (active) setState({ kind: 'unreadable' });
      });

    return () => {
      active = false;
    };
  }, [path, worktreePath, ref]);

  return state;
}

/** Human-readable byte size, mirrors RawFile.tsx's `fmtSize` (duplicated
 *  rather than imported/exported to keep RawFile.tsx outside this leaf's
 *  declared touch set — a five-line pure formatter is cheaper to duplicate
 *  than to widen the diff for). */
export function fmtImageSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}
