// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createRef, useState } from 'react';
import { Button } from './Button';
import { Badge, StatusDot } from './Badge';
import { Panel, PanelHeader, PanelBody } from './Panel';
import { PanelFullscreenProvider } from './panelFullscreenContext';
import { EmptyState, Spinner } from './feedback';
import { Tabs } from './Tabs';
import { Dialog } from './Dialog';
import { Row } from './Row';

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

  // Row regression coverage (D1, local_repo_explorer-row-context-menu-copy-
  // download-ynz8.3): Row was converted to forwardRef so it can be used
  // directly as a Radix `asChild` trigger target (see
  // src/renderer/files/rowMenu.test.tsx for the ContextMenu-integration
  // case). These two tests pin down that the conversion (a) actually
  // forwards a usable ref and (b) left every existing consumer-visible prop
  // behavior — active/prefix/suffix/interactive/onClick/className — intact.
  it('Row forwards its ref to the underlying div (D1)', () => {
    const ref = createRef<HTMLDivElement>();
    render(<Row ref={ref}>a row</Row>);
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
    expect(ref.current?.textContent).toBe('a row');
  });

  it('Row keeps its existing prop behavior after the forwardRef conversion', () => {
    const onClick = vi.fn();
    render(
      <Row
        active
        prefix={<span>PRE</span>}
        suffix={<span>SUF</span>}
        className="extra-class"
        onClick={onClick}
      >
        row label
      </Row>,
    );
    const row = screen.getByText('row label').closest('div.extra-class') as HTMLElement;
    expect(row).toBeInTheDocument();
    expect(row.className).toContain('border-accent'); // active styling
    expect(screen.getByText('PRE')).toBeInTheDocument();
    expect(screen.getByText('SUF')).toBeInTheDocument();
    fireEvent.click(row);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('Row defaults to interactive (cursor-pointer/hover) and can opt out', () => {
    const { rerender } = render(<Row data-testid="row">x</Row>);
    expect(screen.getByTestId('row').className).toContain('cursor-pointer');
    rerender(
      <Row data-testid="row" interactive={false}>
        x
      </Row>,
    );
    expect(screen.getByTestId('row').className).not.toContain('cursor-pointer');
  });
});
