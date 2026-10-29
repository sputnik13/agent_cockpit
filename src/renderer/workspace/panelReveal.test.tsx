// @vitest-environment jsdom
/**
 * Revealing the Content panel for a terminal's `cockpit open` without moving
 * keyboard focus (scenario 16, layout matrix), against the REAL Dockview in
 * jsdom: a Dockview upgrade that changes what activating a group emits, or what
 * a hidden tab's DOM does, fails here.
 *
 * Every case asserts the same four things about what must NOT happen: DOM focus
 * stays on the same element, Dockview's active panel does not change, and
 * Dockview emits NO activation event at all (the event CockpitWorkspace turns into
 * a persisted focus-memory write, `lastActivePanelId` churn and `focusPanel`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import {
  addStubPanel,
  attachedPanels,
  inputOf,
  mountDockview,
  watchActivation,
} from '../testing/dockviewHarness';
import { PanelIds } from './panelIds';
import {
  isDeclinedReveal,
  revealContentWithoutFocus,
  revealDeclinedReason,
  type RevealOutcome,
} from './panelReveal';
import { applyPreset } from './presets';
import type { DockviewApi } from './Workspace';

afterEach(() => cleanup());

const flush = (): Promise<void> =>
  act(async () => {
    await Promise.resolve();
  });

/** The Edit view's shape: [beads] [terminal] [changes] with extra panels added by `layout`. */
function baseColumns(api: DockviewApi): void {
  addStubPanel(api, PanelIds.beads);
  addStubPanel(api, PanelIds.terminal, { referencePanel: PanelIds.beads, direction: 'right' });
  addStubPanel(api, PanelIds.changes, { referencePanel: PanelIds.terminal, direction: 'right' });
}

interface Fixture {
  api: DockviewApi;
  /** The panel that is active (and holds DOM focus) before the reveal. */
  activeId: string;
  /** The element that has DOM focus before the reveal. */
  focused: HTMLElement;
  activation: { events: string[] };
}

type PanelName = (typeof PanelIds)[keyof typeof PanelIds];

/**
 * Mount `layout`, make `active` the active panel and put DOM focus in its input
 * (as in the app, where DOM focus inside a group is what makes it the active
 * group), then start recording activation events.
 */
async function setup(
  layout: (api: DockviewApi) => void,
  active: PanelName = PanelIds.terminal,
): Promise<Fixture> {
  const api = await mountDockview((a) => {
    layout(a);
    a.getPanel(active)?.api.setActive();
  });
  await flush();
  const input = inputOf(active);
  expect(input, `the ${active} stub must be attached before the reveal`).not.toBeNull();
  input!.focus();
  expect(document.activeElement).toBe(input);
  expect(api.activePanel?.id).toBe(active);
  return { api, activeId: active, focused: input!, activation: watchActivation(api) };
}

async function reveal(api: DockviewApi): Promise<RevealOutcome> {
  const outcome = revealContentWithoutFocus(api);
  await flush();
  return outcome;
}

function expectUntouched(fx: Fixture): void {
  expect(document.activeElement, 'DOM focus moved').toBe(fx.focused);
  expect(fx.api.activePanel?.id, 'Dockview active panel changed').toBe(fx.activeId);
  expect(fx.activation.events, 'Dockview emitted an activation event').toEqual([]);
}

describe('revealContentWithoutFocus: Content already on screen', () => {
  it('does nothing when Content is the visible tab of its own group', async () => {
    const fx = await setup((api) => {
      baseColumns(api);
      addStubPanel(api, PanelIds.content, { referencePanel: PanelIds.changes, direction: 'below' });
    });
    expect(await reveal(fx.api)).toBe('already-visible');
    expectUntouched(fx);
    expect(attachedPanels()).toContain('content');
  });

  it('does nothing when Content itself is the maximized group', async () => {
    const fx = await setup((api) => {
      baseColumns(api);
      addStubPanel(api, PanelIds.content, { referencePanel: PanelIds.changes, direction: 'below' });
    });
    const content = fx.api.getPanel(PanelIds.content)!;
    content.api.maximize();
    await flush();
    expect(content.api.isMaximized()).toBe(true);
    const activation = watchActivation(fx.api);
    expect(revealContentWithoutFocus(fx.api)).toBe('already-visible');
    expect(activation.events).toEqual([]);
    expect(content.api.isMaximized()).toBe(true);
  });
});

describe('revealContentWithoutFocus: Content is a background tab', () => {
  it("shows it in its own (non-active) group: Content behind Changes, the terminal's group stays active", async () => {
    const fx = await setup((api) => {
      baseColumns(api);
      addStubPanel(api, PanelIds.content, {
        referencePanel: PanelIds.changes,
        direction: 'within',
      });
      api.getPanel(PanelIds.changes)!.api.setActive();
    });
    expect(attachedPanels()).not.toContain('content'); // hidden: its DOM is detached
    expect(await reveal(fx.api)).toBe('revealed');
    expect(attachedPanels()).toContain('content');
    expect(fx.api.getPanel(PanelIds.content)!.api.isVisible).toBe(true);
    expectUntouched(fx);
  });

  it('WITHHOLDS when Content is tabbed behind the Terminal: the terminal stays attached and focused', async () => {
    const fx = await setup((api) => {
      baseColumns(api);
      addStubPanel(api, PanelIds.content, {
        referencePanel: PanelIds.terminal,
        direction: 'within',
      });
    });
    expect(fx.api.getPanel(PanelIds.content)!.group).toBe(
      fx.api.getPanel(PanelIds.terminal)!.group,
    );
    expect(await reveal(fx.api)).toBe('withheld-terminal');
    expect(attachedPanels()).toContain('terminal');
    expect(attachedPanels()).not.toContain('content');
    expect(inputOf(PanelIds.terminal)).toBe(fx.focused);
    expectUntouched(fx);
  });

  it('protects the terminal even when its group is NOT the active group (the user is in Changes)', async () => {
    const api = await mountDockview((a) => {
      baseColumns(a);
      addStubPanel(a, PanelIds.content, { referencePanel: PanelIds.terminal, direction: 'within' });
      a.getPanel(PanelIds.terminal)!.api.setActive();
      a.getPanel(PanelIds.changes)!.api.setActive(); // active group is now Changes'
    });
    await flush();
    const activation = watchActivation(api);
    const before = document.activeElement;
    expect(api.activePanel?.id).toBe('changes');
    expect(await reveal(api)).toBe('withheld-terminal');
    expect(attachedPanels()).toContain('terminal');
    expect(document.activeElement).toBe(before);
    expect(api.activePanel?.id).toBe('changes');
    expect(activation.events).toEqual([]);
  });

  it('WITHHOLDS when Content is a background tab of the ACTIVE group (not the terminal)', async () => {
    // The user is working in Changes (focus is inside it); Content is tabbed behind it.
    const fx = await setup((api) => {
      baseColumns(api);
      addStubPanel(api, PanelIds.content, {
        referencePanel: PanelIds.changes,
        direction: 'within',
      });
      api.getPanel(PanelIds.changes)!.api.setActive();
    }, PanelIds.changes);
    expect(fx.api.getPanel(PanelIds.content)!.group).toBe(fx.api.activeGroup);
    expect(await reveal(fx.api)).toBe('withheld-active-group');
    expect(fx.api.getPanel(PanelIds.changes)!.group.activePanel?.id).toBe('changes');
    expect(attachedPanels()).toContain('changes');
    expect(attachedPanels()).not.toContain('content');
    expectUntouched(fx);
  });

  it('only the TERMINAL is protected: a shared group whose visible tab is another panel is switched', async () => {
    const fx = await setup((api) => {
      baseColumns(api);
      // [Changes (visible), Terminal2-less group]: Content behind Explorer behind Changes
      addStubPanel(api, PanelIds.explorer, {
        referencePanel: PanelIds.changes,
        direction: 'within',
      });
      addStubPanel(api, PanelIds.content, {
        referencePanel: PanelIds.changes,
        direction: 'within',
      });
      api.getPanel(PanelIds.changes)!.api.setActive();
      api.getPanel(PanelIds.terminal)!.api.setActive();
    });
    expect(await reveal(fx.api)).toBe('revealed');
    expect(fx.api.getPanel(PanelIds.content)!.group.activePanel?.id).toBe('content');
    expectUntouched(fx);
  });
});

describe("revealContentWithoutFocus: the focused element decides, not only Dockview's active group", () => {
  it("WITHHOLDS when the focused element is inside the Content group, even if Dockview's active group is another one", async () => {
    const api = await mountDockview((a) => {
      baseColumns(a);
      addStubPanel(a, PanelIds.content, { referencePanel: PanelIds.changes, direction: 'within' });
      a.getPanel(PanelIds.changes)!.api.setActive();
    });
    await flush();
    const changesInput = inputOf(PanelIds.changes)!;
    changesInput.focus(); // DOM focus in the group that holds Content (behind Changes)
    // A programmatic activation moves Dockview's notion of the active group, not DOM focus.
    api.getPanel(PanelIds.terminal)!.api.setActive();
    await flush();
    expect(document.activeElement).toBe(changesInput);
    expect(api.activeGroup).toBe(api.getPanel(PanelIds.terminal)!.group);
    expect(api.getPanel(PanelIds.content)!.group).not.toBe(api.activeGroup);

    const activation = watchActivation(api);
    expect(await reveal(api)).toBe('withheld-active-group');
    expect(attachedPanels()).toContain('changes'); // the focused panel was not detached
    expect(document.activeElement).toBe(changesInput);
    expect(activation.events).toEqual([]);
  });
});

describe("revealContentWithoutFocus: Dockview's active group counts even when DOM focus is elsewhere", () => {
  it('WITHHOLDS when the Content group is the active group but the focused element is in another panel', async () => {
    const fx = await setup((api) => {
      baseColumns(api);
      addStubPanel(api, PanelIds.content, {
        referencePanel: PanelIds.changes,
        direction: 'within',
      });
      api.getPanel(PanelIds.terminal)!.api.setActive();
    }); // DOM focus is in the terminal's input
    // A programmatic activation moves Dockview's active group to Changes' (which holds
    // Content behind it); DOM focus stays in the terminal (a dialog, the status bar, …).
    fx.api.getPanel(PanelIds.changes)!.api.setActive();
    await flush();
    expect(document.activeElement).toBe(fx.focused);
    const content = fx.api.getPanel(PanelIds.content)!;
    expect(content.group).toBe(fx.api.activeGroup);
    expect(content.group.element.contains(document.activeElement)).toBe(false);

    const activation = watchActivation(fx.api);
    expect(await reveal(fx.api)).toBe('withheld-active-group');
    expect(content.group.activePanel?.id).toBe('changes'); // the group in use kept its tab
    expect(document.activeElement).toBe(fx.focused);
    expect(activation.events).toEqual([]);
  });
});

describe('revealContentWithoutFocus: maximized layouts', () => {
  it('does not leave another group maximized state: Content stays hidden', async () => {
    const fx = await setup((api) => {
      baseColumns(api);
      addStubPanel(api, PanelIds.content, { referencePanel: PanelIds.changes, direction: 'below' });
      api.getPanel(PanelIds.terminal)!.api.setActive();
      api.getPanel(PanelIds.terminal)!.api.maximize();
    });
    expect(fx.api.hasMaximizedGroup()).toBe(true);
    expect(await reveal(fx.api)).toBe('withheld-maximized');
    expect(fx.api.hasMaximizedGroup()).toBe(true);
    expect(fx.api.getPanel(PanelIds.terminal)!.api.isMaximized()).toBe(true);
    expectUntouched(fx);
  });

  it('does not re-add a closed Content panel while another group is maximized', async () => {
    const fx = await setup((api) => {
      baseColumns(api);
      api.getPanel(PanelIds.terminal)!.api.setActive();
      api.getPanel(PanelIds.terminal)!.api.maximize();
    });
    expect(await reveal(fx.api)).toBe('withheld-maximized');
    expect(fx.api.getPanel(PanelIds.content)).toBeUndefined();
    expectUntouched(fx);
  });
});

describe('revealContentWithoutFocus: Content closed (absent from the layout)', () => {
  it('re-adds it under Changes, visible, activating nothing', async () => {
    const fx = await setup(baseColumns);
    expect(fx.api.getPanel(PanelIds.content)).toBeUndefined();
    expect(await reveal(fx.api)).toBe('added');

    const content = fx.api.getPanel(PanelIds.content)!;
    expect(content.group.activePanel).toBe(content); // visible, not a blank group
    expect(attachedPanels()).toContain('content');
    // A group of its own: the terminal's and Changes' groups still hold what they held.
    expect(content.group).not.toBe(fx.api.getPanel(PanelIds.terminal)!.group);
    expect(content.group).not.toBe(fx.api.getPanel(PanelIds.changes)!.group);
    expect(fx.api.getPanel(PanelIds.terminal)!.group.activePanel?.id).toBe('terminal');
    expect(fx.api.getPanel(PanelIds.changes)!.group.activePanel?.id).toBe('changes');
    expectUntouched(fx);
  });

  it('re-adds it as a column at the right edge when Changes is closed too', async () => {
    const fx = await setup((api) => {
      addStubPanel(api, PanelIds.beads);
      addStubPanel(api, PanelIds.terminal, { referencePanel: PanelIds.beads, direction: 'right' });
    });
    expect(await reveal(fx.api)).toBe('added');
    const content = fx.api.getPanel(PanelIds.content)!;
    expect(content.group.activePanel).toBe(content);
    expect(attachedPanels()).toEqual(expect.arrayContaining(['beads', 'terminal', 'content']));
    expectUntouched(fx);
  });

  it('adds it once for two rapid reveals; the second finds it on screen', async () => {
    const fx = await setup(baseColumns);
    const first = revealContentWithoutFocus(fx.api);
    const second = revealContentWithoutFocus(fx.api); // before React has flushed anything
    await flush();
    expect([first, second]).toEqual(['added', 'already-visible']);
    expect(fx.api.panels.filter((p) => p.id === PanelIds.content)).toHaveLength(1);
    expectUntouched(fx);
  });

  it('works on a layout restored from its saved JSON', async () => {
    let json: ReturnType<DockviewApi['toJSON']> | undefined;
    await mountDockview((api) => {
      baseColumns(api);
      addStubPanel(api, PanelIds.content, {
        referencePanel: PanelIds.changes,
        direction: 'within',
      });
      api.getPanel(PanelIds.changes)!.api.setActive();
      api.getPanel(PanelIds.terminal)!.api.setActive();
      json = api.toJSON();
    });
    cleanup();

    const fx = await setup((api) => api.fromJSON(json!));
    expect(attachedPanels()).not.toContain('content');
    expect(await reveal(fx.api)).toBe('revealed');
    expect(attachedPanels()).toContain('content');
    expectUntouched(fx);
  });
});

/**
 * Re-adding a closed Content panel must not resize the terminal. Dockview EQUALIZES
 * every sibling of an added group (`Sizing.Distribute`), so without pinning the
 * terminal's group the Review view's terminal loses a third of its height and any
 * right-edge column halves its width. Sizes need an explicit `api.layout()` (Dockview's
 * grid arithmetic does not measure the DOM), and the real presets are used so the
 * layouts are the ones users have.
 */
describe('revealContentWithoutFocus: re-adding Content never resizes the terminal', () => {
  const sizeOf = (api: DockviewApi, id: PanelName): { width: number; height: number } => {
    const { width, height } = api.getPanel(id)!.group.api;
    return { width, height };
  };

  /** A real preset at a fixed workbench size, with `closed` panels removed. */
  const presetLayout = (preset: 'edit' | 'review', closed: PanelName[]) => (api: DockviewApi) => {
    api.layout(1440, 860);
    applyPreset(api, preset);
    for (const id of closed) api.getPanel(id)!.api.close();
  };

  async function readdAndCompare(layout: (api: DockviewApi) => void) {
    const fx = await setup(layout);
    const terminalBefore = sizeOf(fx.api, PanelIds.terminal);
    const outcome = await reveal(fx.api);
    return { fx, outcome, terminalBefore };
  }

  function expectTerminalAndContent(
    fx: Fixture,
    terminalBefore: { width: number; height: number },
  ) {
    expect(sizeOf(fx.api, PanelIds.terminal), 'the terminal was resized').toEqual(terminalBefore);
    const content = fx.api.getPanel(PanelIds.content)!;
    expect(content.group.activePanel).toBe(content); // visible, not a blank group
    expect(content.group.api.width).toBeGreaterThanOrEqual(100);
    expect(content.group.api.height).toBeGreaterThanOrEqual(100);
    // The pin is released: the terminal group's constraints are Dockview's defaults again.
    const terminal = fx.api.getPanel(PanelIds.terminal)!.group;
    expect(terminal.minimumWidth).toBe(100);
    expect(terminal.minimumHeight).toBe(100);
    expect(terminal.maximumWidth).toBeGreaterThan(100_000);
    expect(terminal.maximumHeight).toBeGreaterThan(100_000);
    expectUntouched(fx);
  }

  it('Edit (Changes and Explorer tabbed): only the Changes cell is split', async () => {
    const { fx, outcome, terminalBefore } = await readdAndCompare(
      presetLayout('edit', [PanelIds.content]),
    );
    expect(outcome).toBe('added');
    expectTerminalAndContent(fx, terminalBefore);
    const changes = sizeOf(fx.api, PanelIds.changes);
    const content = sizeOf(fx.api, PanelIds.content);
    expect(changes.height + content.height).toBe(860); // they share the old Changes column
    expect(sizeOf(fx.api, PanelIds.beads)).toEqual({ width: 288, height: 430 });
  });

  it('Review (the terminal sits below Changes in the same column): the terminal keeps its height', async () => {
    const { fx, outcome, terminalBefore } = await readdAndCompare(
      presetLayout('review', [PanelIds.content]),
    );
    expect(terminalBefore).toEqual({ width: 720, height: 430 });
    expect(outcome).toBe('added');
    expectTerminalAndContent(fx, terminalBefore);
    // Changes and Content split the cell Changes had; nothing else moved.
    expect(sizeOf(fx.api, PanelIds.changes).height + sizeOf(fx.api, PanelIds.content).height).toBe(
      430,
    );
    expect(sizeOf(fx.api, PanelIds.beads)).toEqual({ width: 720, height: 430 });
  });

  it('right-edge fallback (Edit without Changes): a new column; the terminal keeps its width', async () => {
    const { fx, outcome, terminalBefore } = await readdAndCompare(
      presetLayout('edit', [PanelIds.content, PanelIds.explorer, PanelIds.changes]),
    );
    expect(terminalBefore.width).toBe(720);
    expect(outcome).toBe('added');
    expectTerminalAndContent(fx, terminalBefore);
    expect(sizeOf(fx.api, PanelIds.content).height).toBe(860); // a full-height column
  });

  it('right-edge fallback (Review without Changes): the terminal, sharing a column, keeps both sizes', async () => {
    const { fx, outcome, terminalBefore } = await readdAndCompare(
      presetLayout('review', [PanelIds.content, PanelIds.changes]),
    );
    expect(outcome).toBe('added');
    expectTerminalAndContent(fx, terminalBefore);
    expect(sizeOf(fx.api, PanelIds.content).height).toBe(860);
  });

  it('Changes tabbed WITH the terminal: Content is not carved out of the terminal, it goes to the right edge', async () => {
    const { fx, outcome, terminalBefore } = await readdAndCompare((api) => {
      api.layout(1440, 860);
      addStubPanel(api, PanelIds.beads);
      addStubPanel(api, PanelIds.terminal, { referencePanel: PanelIds.beads, direction: 'right' });
      addStubPanel(api, PanelIds.changes, {
        referencePanel: PanelIds.terminal,
        direction: 'within',
      });
      api.getPanel(PanelIds.terminal)!.api.setActive();
    });
    expect(fx.api.getPanel(PanelIds.changes)!.group).toBe(
      fx.api.getPanel(PanelIds.terminal)!.group,
    );
    expect(outcome).toBe('added');
    expectTerminalAndContent(fx, terminalBefore);
    expect(fx.api.getPanel(PanelIds.content)!.group).not.toBe(
      fx.api.getPanel(PanelIds.terminal)!.group,
    );
  });

  it('a Changes cell too short to split falls back to the right edge (and the terminal still keeps its size)', async () => {
    const { fx, outcome, terminalBefore } = await readdAndCompare((api) => {
      presetLayout('review', [PanelIds.content])(api);
      api.getPanel(PanelIds.terminal)!.group.api.setSize({ height: 700 }); // Changes: 160px
      api.getPanel(PanelIds.terminal)!.api.setActive();
    });
    expect(terminalBefore.height).toBe(700);
    expect(sizeOf(fx.api, PanelIds.changes).height).toBeLessThan(200);
    expect(outcome).toBe('added');
    expectTerminalAndContent(fx, terminalBefore);
    expect(sizeOf(fx.api, PanelIds.content).height).toBe(860); // a right-edge column, not a split
  });

  it('DECLINES when the terminal cannot keep its size and still leave room: nothing is added', async () => {
    const fx = await setup((api) => {
      api.layout(1440, 860);
      addStubPanel(api, PanelIds.terminal);
    });
    const terminalBefore = sizeOf(fx.api, PanelIds.terminal);
    expect(terminalBefore).toEqual({ width: 1440, height: 860 });
    expect(await reveal(fx.api)).toBe('withheld-no-room');
    expect(fx.api.getPanel(PanelIds.content)).toBeUndefined();
    expect(sizeOf(fx.api, PanelIds.terminal)).toEqual(terminalBefore);
    expectUntouched(fx);
  });
});

describe('why the reveal never calls setActive (pinned Dockview behavior)', () => {
  it('plain setActive on the same background tab DOES activate: a group + panel event the focus handlers act on', async () => {
    const fx = await setup((api) => {
      baseColumns(api);
      addStubPanel(api, PanelIds.content, {
        referencePanel: PanelIds.changes,
        direction: 'within',
      });
      api.getPanel(PanelIds.changes)!.api.setActive();
      api.getPanel(PanelIds.terminal)!.api.setActive();
    });
    fx.api.getPanel(PanelIds.content)!.api.setActive();
    await flush();
    // The panel event is what CockpitWorkspace turns into writeFocus + focusPanel.
    expect(fx.activation.events).toContain('panel:content');
    expect(fx.api.activePanel?.id).toBe('content');
  });

  it('switching the visible tab of the ACTIVE group detaches the focused panel: DOM focus falls to BODY', async () => {
    const fx = await setup((api) => {
      baseColumns(api);
      addStubPanel(api, PanelIds.content, {
        referencePanel: PanelIds.terminal,
        direction: 'within',
      });
      api.getPanel(PanelIds.terminal)!.api.setActive();
    });
    const content = fx.api.getPanel(PanelIds.content)!;
    content.group.model.openPanel(content, { skipSetGroupActive: true });
    await flush();
    expect(attachedPanels()).not.toContain('terminal');
    expect(document.activeElement).toBe(document.body);
    expect(fx.activation.events).toContain('panel:content');
  });
});

describe('revealDeclinedReason', () => {
  it('has a reason for every outcome that leaves Content hidden, and none for the rest', () => {
    const shown: RevealOutcome[] = ['already-visible', 'revealed', 'added'];
    const hidden: RevealOutcome[] = [
      'withheld-terminal',
      'withheld-active-group',
      'withheld-maximized',
      'withheld-no-room',
      'unavailable',
      'not-loaded',
    ];
    for (const outcome of shown) expect(revealDeclinedReason(outcome)).toBeNull();
    for (const outcome of hidden) expect(revealDeclinedReason(outcome)).toMatch(/\S/);
  });

  it('flags exactly the deliberate declines for a user-visible cue', () => {
    const declined: RevealOutcome[] = [
      'withheld-terminal',
      'withheld-active-group',
      'withheld-maximized',
      'withheld-no-room',
    ];
    const others: RevealOutcome[] = [
      'already-visible',
      'revealed',
      'added',
      'unavailable',
      'not-loaded',
    ];
    for (const outcome of declined) expect(isDeclinedReveal(outcome)).toBe(true);
    for (const outcome of others) expect(isDeclinedReveal(outcome)).toBe(false);
  });
});
