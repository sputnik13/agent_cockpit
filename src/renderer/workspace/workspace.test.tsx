// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { Workspace, agentCockpitDockviewTheme } from './Workspace';

// dockview-core observes element sizing via ResizeObserver, which jsdom does
// not implement. Provide a no-op stub so the host can mount in the test env.
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
});

afterEach(() => {
  cleanup();
});

describe('Workspace', () => {
  it('mounts a themed Dockview container without throwing', () => {
    const onReady = vi.fn();

    const { container } = render(<Workspace components={{}} onReady={onReady} />);

    const themed = container.querySelector(`.${agentCockpitDockviewTheme.className}`);
    expect(themed).not.toBeNull();
    expect(themed).toHaveClass('agent-cockpit-workspace');
  });

  it('forwards an extra className onto the host root', () => {
    render(<Workspace components={{}} onReady={vi.fn()} className="extra-host" />);

    const themed = document.querySelector(`.${agentCockpitDockviewTheme.className}`);
    expect(themed).toHaveClass('extra-host');
  });
});
