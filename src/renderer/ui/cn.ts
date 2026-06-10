/** Join class names, dropping falsy values. Minimal local helper (no dep). */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
