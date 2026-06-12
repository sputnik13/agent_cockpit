import { cn } from '../../ui/cn';

/**
 * Renders a vendored SVG icon (raw markup) in a fixed 16px box. The SVGs are
 * trusted, repo-vendored assets, so `dangerouslySetInnerHTML` is safe here.
 * Tinted icons inherit the current text color (their SVG uses
 * `fill="currentColor"`); brand icons keep their own published colors.
 */
export function IconSvg({ svg, tinted }: { svg: string; tinted: boolean }): JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:h-full [&>svg]:w-full',
        tinted && 'text-dim',
      )}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
