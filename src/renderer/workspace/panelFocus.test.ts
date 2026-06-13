import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PanelIds } from './panelIds';
import {
  registerPanelFocus,
  focusPanel,
  focusPanelForce,
  setFocusSuppressed,
  withFocusSuppressed,
  __resetPanelFocusForTest,
} from './panelFocus';

beforeEach(() => __resetPanelFocusForTest());

describe('panelFocus registry', () => {
  it('fires the handler immediately when one is registered', () => {
    const h = vi.fn();
    registerPanelFocus(PanelIds.explorer, h);
    focusPanel(PanelIds.explorer);
    expect(h).toHaveBeenCalledTimes(1);
  });

  it('defers to a pending focus when the handler is not registered yet', () => {
    const h = vi.fn();
    focusPanel(PanelIds.explorer); // no handler yet -> pending
    expect(h).not.toHaveBeenCalled();
    registerPanelFocus(PanelIds.explorer, h); // registering fires the pending focus
    expect(h).toHaveBeenCalledTimes(1);
  });

  it('does not fire a panel whose id was not the pending target', () => {
    const other = vi.fn();
    focusPanel(PanelIds.explorer); // pending = explorer
    registerPanelFocus(PanelIds.changes, other); // different id
    expect(other).not.toHaveBeenCalled();
  });

  it('clears a stale pending target once a concrete focus happens', () => {
    const changes = vi.fn();
    focusPanel(PanelIds.explorer); // pending = explorer, never mounts
    registerPanelFocus(PanelIds.changes, changes);
    focusPanel(PanelIds.changes); // concrete focus clears pending
    // now mounting explorer must NOT retroactively focus it
    const explorer = vi.fn();
    registerPanelFocus(PanelIds.explorer, explorer);
    expect(explorer).not.toHaveBeenCalled();
    expect(changes).toHaveBeenCalledTimes(1);
  });

  describe('suppression', () => {
    it('focusPanel is a no-op while suppressed', () => {
      const h = vi.fn();
      registerPanelFocus(PanelIds.explorer, h);
      setFocusSuppressed(true);
      focusPanel(PanelIds.explorer);
      expect(h).not.toHaveBeenCalled();
      setFocusSuppressed(false);
    });

    it('focusPanelForce fires even while suppressed', () => {
      const h = vi.fn();
      registerPanelFocus(PanelIds.explorer, h);
      setFocusSuppressed(true);
      focusPanelForce(PanelIds.explorer);
      expect(h).toHaveBeenCalledTimes(1);
      setFocusSuppressed(false);
    });

    it('withFocusSuppressed suppresses within and restores the prior flag', () => {
      const h = vi.fn();
      registerPanelFocus(PanelIds.explorer, h);
      withFocusSuppressed(() => focusPanel(PanelIds.explorer));
      expect(h).not.toHaveBeenCalled();
      // restored to not-suppressed afterward
      focusPanel(PanelIds.explorer);
      expect(h).toHaveBeenCalledTimes(1);
    });
  });

  describe('unregister', () => {
    it('removes only its own handler', () => {
      const first = vi.fn();
      const unregisterFirst = registerPanelFocus(PanelIds.explorer, first);
      const second = vi.fn();
      registerPanelFocus(PanelIds.explorer, second); // newer handler wins
      unregisterFirst(); // stale cleanup must NOT remove the newer handler
      focusPanel(PanelIds.explorer);
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
    });
  });
});
