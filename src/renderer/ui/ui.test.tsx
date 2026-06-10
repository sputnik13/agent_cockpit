// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { Button } from './Button';
import { Badge, StatusDot } from './Badge';
import { Panel, PanelHeader, PanelBody } from './Panel';
import { PanelFullscreenProvider } from './panelFullscreenContext';
import { EmptyState, Spinner } from './feedback';
import { Tabs } from './Tabs';
import { Dialog } from './Dialog';

describe('UI primitives', () => {
  it('renders Button with role and respects disabled', () => {
    const { rerender } = render(<Button>Go</Button>);
    expect(screen.getByRole('button', { name: 'Go' })).toBeInTheDocument();
    rerender(
      <Button disabled variant="primary">
        Go
      </Button>,
    );
    expect(screen.getByRole('button', { name: 'Go' })).toBeDisabled();
  });

  it('renders Badge, StatusDot, Spinner, EmptyState', () => {
    render(
      <div>
        <Badge tone="added">A</Badge>
        <StatusDot tone="accent" />
        <Spinner />
        <EmptyState title="Nothing here" hint="pick a file" />
      </div>,
    );
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });

  it('renders Panel header/body composition', () => {
    render(
      <Panel>
        <PanelHeader title="Changes" actions={<Button size="sm">x</Button>} />
        <PanelBody>content</PanelBody>
      </Panel>,
    );
    expect(screen.getByText('Changes')).toBeInTheDocument();
    expect(screen.getByText('content')).toBeInTheDocument();
  });

  it('PanelHeader renders no maximize control outside a Dockview host (FA-2)', () => {
    render(<PanelHeader title="Changes" />);
    expect(screen.queryByRole('button', { name: /maximize panel|restore panel/i })).toBeNull();
  });

  it('PanelHeader shows a Maximize control and toggles via context (FA-2)', () => {
    const toggle = vi.fn();
    render(
      <PanelFullscreenProvider value={{ isMaximized: false, toggle }}>
        <PanelHeader title="Changes" />
      </PanelFullscreenProvider>,
    );
    const btn = screen.getByRole('button', { name: 'Maximize panel' });
    fireEvent.click(btn);
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('PanelHeader reflects the maximized state as a Restore control (FA-2)', () => {
    render(
      <PanelFullscreenProvider value={{ isMaximized: true, toggle: () => {} }}>
        <PanelHeader title="Changes" actions={<Button size="sm">fa2-action</Button>} />
      </PanelFullscreenProvider>,
    );
    // Coexists with the panel's own actions (unique label avoids collision with
    // other tests — this file does not clean up the DOM between cases).
    expect(screen.getByRole('button', { name: 'fa2-action' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore panel' })).toBeInTheDocument();
  });

  it('Tabs (Radix) exposes tab roles + tabpanel and shows the default panel', () => {
    render(
      <Tabs
        tabs={[
          { value: 'a', label: 'Diff', content: <div>diff-body</div> },
          { value: 'b', label: 'Raw', content: <div>raw-body</div> },
        ]}
      />,
    );
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(screen.getByRole('tabpanel')).toBeInTheDocument();
    expect(screen.getByText('diff-body')).toBeInTheDocument();
  });

  it('Dialog (Radix) renders content with dialog role when open', () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <Dialog open={open} onOpenChange={setOpen} title="Remove project" description="local only">
          <div>body</div>
        </Dialog>
      );
    }
    render(<Harness />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Remove project')).toBeInTheDocument();
  });
});
