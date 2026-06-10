import { useCallback, useEffect, useState } from 'react';
import type { TmuxSessionInfo } from '@shared/ipc/channels';
import { agentCockpit } from '../providerClient';
import { Badge, Button, Dialog, EmptyState, IconButton, Spinner, Tooltip } from '../ui';

/**
 * Management modal for every tmux session on the agentCockpit socket — including
 * orphans from removed projects. Each can be attached manually (copy the command
 * into your own terminal) or killed; "Kill detached" cleans up everything not
 * currently attached. Opened from the Terminal panel header (mirrors Manage
 * Projects); refreshes its list each time it opens.
 */
export function SessionsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const [sessions, setSessions] = useState<TmuxSessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setSessions(await agentCockpit.sessions.list());
    } finally {
      setLoading(false);
    }
  }, []);

  // Refresh whenever the modal opens.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const copy = async (s: TmuxSessionInfo): Promise<void> => {
    try {
      await navigator.clipboard.writeText(s.attachCommand);
      setCopied(s.name);
      setTimeout(() => setCopied((c) => (c === s.name ? null : c)), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const detached = sessions.filter((s) => !s.attached).length;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Sessions"
      description={`${sessions.length} session(s) · ${detached} detached`}
      className="w-[min(92vw,560px)]"
      footer={
        <>
          <Button size="sm" onClick={() => void refresh()}>
            Refresh
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={detached === 0}
            onClick={() => void agentCockpit.sessions.killDetached().then(refresh)}
          >
            Kill detached
          </Button>
          <Button size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </>
      }
    >
      <div className="max-h-[50vh] overflow-auto rounded border border-edge">
        {loading ? (
          <div className="flex items-center gap-2 px-2 py-2 text-xs text-dim">
            <Spinner /> loading…
          </div>
        ) : sessions.length === 0 ? (
          <EmptyState title="No terminal sessions" hint="Open a terminal to start one." />
        ) : (
          sessions.map((s) => (
            <div key={s.name} className="flex items-center gap-2 border-b border-edge px-2 py-1.5 last:border-b-0">
              <Badge tone={s.attached ? 'added' : 'neutral'}>
                {s.attached ? 'attached' : 'detached'}
              </Badge>
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg" title={s.name}>
                {s.name}
              </span>
              <span className="text-[10px] text-dim">{s.windows}w</span>
              <Tooltip content={s.attachCommand}>
                <Button size="sm" onClick={() => void copy(s)}>
                  {copied === s.name ? 'Copied ✓' : 'Copy attach'}
                </Button>
              </Tooltip>
              <IconButton
                label={`Kill ${s.name}`}
                size="sm"
                variant="danger"
                onClick={() => void agentCockpit.sessions.kill(s.name).then(refresh)}
              >
                ×
              </IconButton>
            </div>
          ))
        )}
      </div>
    </Dialog>
  );
}
