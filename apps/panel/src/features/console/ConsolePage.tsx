import { useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Terminal as XTerm } from '@xterm/xterm';
import { getServer } from '@/features/servers/servers.api';
import { useServerSocket } from '@/shared/realtime/useServerSocket';
import { Terminal } from './Terminal';
import { StatsChart, type StatsChartHandle } from './StatsChart';
import { PowerControls } from './PowerControls';
import { Alert, Button, Input, StatusBadge } from '@/ui/primitives';

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
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight text-text">{server?.name ?? '…'}</h1>
          <StatusBadge status={displayState} />
        </div>
        <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${connected ? 'text-ok' : 'text-text-faint'}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-ok' : 'bg-text-faint'}`} />
          {CONN_LABEL[connectionState]}
        </span>
      </div>

      <PowerControls state={displayState} permissions={permissions} onAction={sendPower} />

      {lastError && <Alert>{lastError}</Alert>}

      <StatsChart ref={statsRef} />

      {/* Deliberately bounded. xterm's FitAddon derives its row count from
          the container's clientHeight — an auto-height parent measures 0 and
          the terminal renders no rows at all. This is one of the few places
          the redesign keeps a fixed-height box on purpose. */}
      <div className="h-[clamp(320px,55vh,760px)]">
        <Terminal onReady={(t) => (termRef.current = t)} disabled={!connected} />
      </div>

      <form onSubmit={submitCommand} className="flex gap-2">
        <Input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          disabled={!connected || !permissions.includes('control.console')}
          placeholder={connected ? 'Digite um comando e pressione Enter…' : 'Aguardando conexão…'}
          className="font-mono"
        />
        <Button type="submit" variant="primary" disabled={!connected || !command.trim()}>
          Enviar
        </Button>
      </form>
    </div>
  );
}
