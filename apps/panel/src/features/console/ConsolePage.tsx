import { useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Terminal as XTerm } from '@xterm/xterm';
import { getServer } from '@/features/servers/servers.api';
import { useServerSocket } from '@/shared/realtime/useServerSocket';
import { Terminal } from './Terminal';
import { StatsChart, type StatsChartHandle } from './StatsChart';
import { PowerControls } from './PowerControls';
import { StatusBadge } from '@/ui/primitives/Badge';
import { Button } from '@/ui/primitives/Button';

const CONN_LABEL: Record<string, string> = {
  idle: 'Iniciando…',
  connecting: 'Conectando…',
  authenticating: 'Autenticando…',
  open: 'Conectado',
  reconnecting: 'Reconectando…',
  failed: 'Falha na conexão',
};

export function ConsolePage({ serverId }: { serverId: string }) {
  const { data: server } = useQuery({ queryKey: ['server', serverId], queryFn: () => getServer(serverId) });
  const [powerState, setPowerState] = useState<string | null>(null);
  const [command, setCommand] = useState('');
  const termRef = useRef<XTerm | null>(null);
  const statsRef = useRef<StatsChartHandle>(null);

  const { connectionState, permissions, lastError, sendCommand, sendPower } = useServerSocket({
    serverId,
    terminal: termRef.current,
    // The agent never writes power_state back to the database (M2's
    // control API is agent-local, in-memory) — status events only fire
    // on a power ACTION, so a fresh page load has no way to learn the
    // real current state until one happens. The periodic stats frame
    // already carries it (StatsFrame.state), so every frame is also the
    // ambient truth for "is it actually running right now" — found live:
    // reloading mid-session showed a stale "offline" badge on an already
    // -running container, and clicking Start then failed with "already
    // running".
    onStats: (frame) => {
      statsRef.current?.pushFrame(frame);
      setPowerState(frame.state);
    },
    onStatus: (data) => setPowerState(data.state),
  });

  const displayState = powerState ?? server?.powerState ?? 'offline';
  const connected = connectionState === 'open';

  function submitCommand(e: FormEvent) {
    e.preventDefault();
    if (!command.trim()) return;
    sendCommand(command);
    setCommand('');
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="font-medium text-text">{server?.name ?? '…'}</h1>
          <StatusBadge status={displayState} />
        </div>
        <span className={`font-mono text-xs ${connected ? 'text-ok' : 'text-text-faint'}`}>{CONN_LABEL[connectionState]}</span>
      </div>

      <PowerControls state={displayState} permissions={permissions} onAction={sendPower} />

      {lastError && <p className="rounded-md bg-fail-tint px-3 py-2 text-sm text-fail">{lastError}</p>}

      <StatsChart ref={statsRef} />

      <div className="min-h-0 flex-1">
        <Terminal onReady={(t) => (termRef.current = t)} disabled={!connected} />
      </div>

      <form onSubmit={submitCommand} className="flex gap-2">
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          disabled={!connected || !permissions.includes('control.console')}
          placeholder={connected ? 'Digite um comando e pressione Enter…' : 'Aguardando conexão…'}
          className="flex-1 rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-sm text-text outline-none focus:border-accent disabled:opacity-50"
        />
        <Button type="submit" variant="primary" disabled={!connected || !command.trim()}>
          Enviar
        </Button>
      </form>
    </div>
  );
}
