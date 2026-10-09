/** True when an event belongs to the terminal panel, never another app control. */
export function isTerminalKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (
    target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]') &&
    !target.closest('.ac-term')
  )
    return false;
  return target.closest('.ac-term, [data-terminal-shortcut-scope]') !== null;
}
