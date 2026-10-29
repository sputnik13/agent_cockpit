/**
 * Test harness: a REAL Dockview in jsdom with stub panel contents, built with
 * the app's own panel options (`panelOptions`: component `panel-host`, params
 * `{panelId}`) so a layout built here can be saved with `toJSON()` and restored by
 * `CockpitWorkspace` exactly as a user's saved layout is. Used by the panel
 * reveal / callback-open tests.
 *
 * Test-only: this directory is excluded from the production TypeScript project
 * (`tsconfig.renderer.json`) and nothing in the app imports it; it is type-checked
 * with the tests that use it (`tsconfig.renderer-tests.json`).
 */
import { useRef, type FunctionComponent } from 'react';
import { act, render } from '@testing-library/react';
import type { IDockviewPanelProps } from 'dockview-react';
import { Workspace, type DockviewApi, type DockviewReadyEvent } from '../workspace/Workspace';
import { usePanelFocusOverride } from '../workspace/panelFocusContext';
import { panelOptions } from '../workspace/presets';
import type { PanelId } from '../workspace/panelIds';

/** dockview observes element sizing via ResizeObserver, which jsdom lacks. */
export function installResizeObserverStub(): void {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
}

/**
 * A panel's stand-in contents: one `<input data-testid="in-<id>">` inside
 * `<div data-panel="<id>">`, so a test can put DOM focus in a panel and see
 * whether the panel is attached (Dockview's default `onlyWhenVisible` renderer
 * detaches a hidden tab's DOM).
 */
export function PanelStub({ id }: { id: PanelId }): JSX.Element {
  return (
    <div data-panel={id}>
      <input data-testid={`in-${id}`} />
    </div>
  );
}

/** A component rendering `PanelStub` (for `vi.mock` factories, which must not contain JSX). */
export function stubPanel(id: PanelId): FunctionComponent {
  const Stub = (): JSX.Element => <PanelStub id={id} />;
  Stub.displayName = `Stub(${id})`;
  return Stub;
}

/**
 * The Terminal's stand-in for the real panel: like `TerminalPanel` it overrides
 * the panel's keyboard-focus handler (the real one dispatches
 * `FOCUS_TERMINAL_EVENT` to focus the active xterm pane; this one focuses its
 * input), so `focusPanel('terminal')` really moves DOM focus into it.
 */
export function TerminalStub(): JSX.Element {
  const input = useRef<HTMLInputElement>(null);
  usePanelFocusOverride(() => input.current?.focus());
  return (
    <div data-panel="terminal">
      <input data-testid="in-terminal" ref={input} />
    </div>
  );
}

/** Stand-in for `PanelHost` when the real one is not under test. */
export const StubHost: FunctionComponent<IDockviewPanelProps<{ panelId: PanelId }>> = (props) => (
  <PanelStub id={props.params.panelId} />
);

/**
 * A Map-backed `localStorage` for tests (jsdom under Node 26 has none; see
 * focusMemory.test.ts). Supports `length`/`key()` too, which the Content tab
 * persistence's bulk clear uses. Returns the backing map.
 */
export function installFakeLocalStorage(): Map<string, string> {
  const backing = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => void backing.set(k, String(v)),
    removeItem: (k: string) => void backing.delete(k),
    clear: () => backing.clear(),
    key: (i: number) => [...backing.keys()][i] ?? null,
    get length() {
      return backing.size;
    },
  };
  return backing;
}

export function removeFakeLocalStorage(): void {
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
}

/** Mount a Dockview, let `build` lay it out in `onReady`, and flush the first render. */
export async function mountDockview(build: (api: DockviewApi) => void): Promise<DockviewApi> {
  installResizeObserverStub();
  let api!: DockviewApi;
  const onReady = (event: DockviewReadyEvent): void => {
    api = event.api;
    build(event.api);
  };
  render(
    <Workspace
      components={{ 'panel-host': StubHost as FunctionComponent<IDockviewPanelProps> }}
      onReady={onReady}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  return api;
}

type Position = Parameters<DockviewApi['addPanel']>[0]['position'];

/** Add panel `id` with the app's own options. */
export function addStubPanel(api: DockviewApi, id: PanelId, position?: Position, active = true) {
  return api.addPanel({
    ...panelOptions(id),
    ...(position ? { position } : {}),
    ...(active ? {} : { inactive: true }),
  });
}

/** The panel contents currently attached to the document, by panel id. */
export const attachedPanels = (): string[] =>
  [...document.querySelectorAll('[data-panel]')].map((el) => el.getAttribute('data-panel')!);

/** The stub's focusable input for panel `id`, or null when its content is detached. */
export const inputOf = (id: PanelId): HTMLInputElement | null =>
  document.querySelector<HTMLInputElement>(`[data-testid="in-${id}"]`);

/**
 * Record every global activation Dockview emits from now on (the active panel
 * and the active group). The panel event REPLAYS its last value on subscribe, so
 * the log starts empty after that synchronous replay.
 */
export function watchActivation(api: DockviewApi): { events: string[] } {
  const events: string[] = [];
  api.onDidActivePanelChange((panel) => events.push(`panel:${panel?.id}`));
  api.onDidActiveGroupChange((group) => events.push(`group:${group?.id}`));
  events.length = 0;
  return { events };
}
