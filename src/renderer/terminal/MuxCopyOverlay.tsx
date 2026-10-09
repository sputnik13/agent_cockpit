import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { TerminalScrollbackLine } from '@shared/providers/types';
import * as registry from './terminalRegistry';
import { Button } from '../ui';

const PAGE_LINES = 200;

function ansiColor(index: number): string | undefined {
  const base = ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5', '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3'];
  if (index < base.length) return base[index];
  if (index >= 232 && index <= 255) {
    const value = 8 + (index - 232) * 10;
    return `rgb(${value}, ${value}, ${value})`;
  }
  if (index >= 16 && index <= 231) {
    const offset = index - 16;
    const component = (value: number): number => value === 0 ? 0 : 55 + value * 40;
    return `rgb(${component(Math.floor(offset / 36))}, ${component(Math.floor((offset % 36) / 6))}, ${component(offset % 6)})`;
  }
  return undefined;
}

/** Converts the daemon's constrained SGR run payload into safe DOM styles. */
export function sgrStyle(sgr: string): CSSProperties {
  const style: CSSProperties = {};
  const codes = sgr.split(';').filter(Boolean);
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index]!;
    if (code === '1') style.fontWeight = 700;
    else if (code === '2') style.opacity = 0.72;
    else if (code === '3') style.fontStyle = 'italic';
    else if (code === '4' || code.startsWith('4:')) {
      style.textDecorationLine = style.textDecorationLine === 'line-through' ? 'underline line-through' : 'underline';
      const underline = code === '4' ? undefined : code.slice(2);
      style.textDecorationStyle = underline === '2' ? 'double' : underline === '3' ? 'wavy' : underline === '4' ? 'dotted' : underline === '5' ? 'dashed' : undefined;
    } else if (code === '5') style.animation = 'pulse 1s step-end infinite';
    else if (code === '7') style.filter = 'invert(1)';
    else if (code === '8') style.visibility = 'hidden';
    else if (code === '9') style.textDecorationLine = style.textDecorationLine === 'underline' ? 'underline line-through' : 'line-through';
    else if (code === '53') style.textDecorationLine = style.textDecorationLine ? `${style.textDecorationLine} overline` : 'overline';
    else if ((code === '38' || code === '48') && codes[index + 1] === '5') {
      const color = ansiColor(Number(codes[index + 2]));
      if (color) {
        if (code === '38') style.color = color;
        else style.backgroundColor = color;
      }
      index += 2;
    } else if ((code === '38' || code === '48') && codes[index + 1] === '2') {
      const rgb = codes.slice(index + 2, index + 5).map(Number);
      if (rgb.length === 3 && rgb.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
        if (code === '38') style.color = `rgb(${rgb.join(', ')})`;
        else style.backgroundColor = `rgb(${rgb.join(', ')})`;
      }
      index += 4;
    }
  }
  return style;
}

/** Renderer-local copy surface for a mux/wterm terminal. */
export function MuxCopyOverlay({ projectId, terminalKey, onClose }: {
  projectId: string;
  terminalKey: string;
  onClose: () => void;
}): JSX.Element {
  const [offset, setOffset] = useState(0);
  const [lines, setLines] = useState<TerminalScrollbackLine[]>([]);
  useEffect(() => {
    let disposed = false;
    void registry.muxScrollbackLines(projectId, 'terminal', terminalKey, offset, PAGE_LINES)
      .then((result) => { if (!disposed) setLines(result); });
    return () => { disposed = true; };
  }, [projectId, terminalKey, offset]);
  const text = useMemo(() => lines.map((line) => line.runs.map((run) => run.text).join('')).join('\n'), [lines]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'PageUp') {
        event.preventDefault();
        setOffset((current) => current + PAGE_LINES);
      } else if (event.key === 'PageDown') {
        event.preventDefault();
        setOffset((current) => Math.max(0, current - PAGE_LINES));
      } else if (event.key === 'Home') {
        event.preventDefault();
        setOffset(0);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-bg/95 p-3 text-xs">
      <div className="mb-2 flex items-center gap-2">
        <strong>Copy mode</strong>
        <span className="text-dim">Esc closes; history stays local to this renderer.</span>
        <div className="ml-auto flex gap-1">
          <Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_LINES))}>Newer</Button>
          <Button size="sm" disabled={lines.length < PAGE_LINES} onClick={() => setOffset(offset + PAGE_LINES)}>Older</Button>
          <Button size="sm" onClick={() => void navigator.clipboard?.writeText(text).catch(() => {})}>Copy page</Button>
          <Button size="sm" onClick={onClose}>Close</Button>
        </div>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap select-text">{lines.length > 0 ? lines.map((line) => (
        <div key={line.line}>{line.runs.map((run, index) => <span key={index} data-sgr={run.sgr} style={sgrStyle(run.sgr)}>{run.text}</span>)}</div>
      )) : '[No scrollback available yet.]'}</pre>
    </div>
  );
}
