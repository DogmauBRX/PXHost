import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Terminal as XTerm } from '@xterm/xterm';
import { Clock } from 'lucide-react';
import { getServer } from '@/features/servers/servers.api';
import { useServerSocket } from '@/shared/realtime/useServerSocket';
import { Terminal } from './Terminal';
import { StatsChart, type StatsChartHandle } from './StatsChart';
import { PowerControls } from './PowerControls';
import { ResourceAdvisory } from '@/features/client/ResourceAdvisory';
import { combineSeverity, cpuSeverity, memorySeverity, SUSTAINED_FRAMES, type Severity } from '@/features/client/advisory';
import { Alert, Button, Input, StatusBadge } from '@/ui/primitives';
import type { ServerStatsSnapshot } from '@/shared/api/types';

// "1d 2h", "2h 15m", "15m 32s", "32s" — coarsest-two-units, matching how
// the meter/hint labels elsewhere in this app stay compact rather than
// spelling out every unit down to the second once the number is large.
function formatUptime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function buildLiveSnapshot(usage: { memoryBytes: number; memoryLimitBytes: number; cpuPercent: number; cpuLimitPercent: number }, state: string): ServerStatsSnapshot {
  return {
    online: true,
    state,
    cpuPercent: usage.cpuPercent,
    cpuLimitPercent: usage.cpuLimitPercent,
    memoryBytes: usage.memoryBytes,
    memoryLimitBytes: usage.memoryLimitBytes,
    networkRxBytes: null,
    networkTxBytes: null,
    uptimeMs: null,
    measuredAt: new Date().toISOString(),
  };
}

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

  // Raw usage numbers live in a ref, never state — a stats frame arrives
  // every 2s and its numbers fluctuate almost every time, so putting them
  // in useState would re-render this page every 2s, exactly what
  // architecture doc 5.2 forbids. `liveSeverity` is the one thing derived
  // from each frame that DOES go through setState, because it's a
  // low-cardinality string ('none' the overwhelming majority of the time)
  // — React's same-value bailout means calling setState with an unchanged
  // string costs nothing, the same trick `setPowerState` above already
  // relies on.
  const latestUsageRef = useRef<{ memoryBytes: number; memoryLimitBytes: number; cpuPercent: number; cpuLimitPercent: number } | null>(null);
  // The agent's own `uptime_ms` (re-synced from every frame, so client
  // clock drift between frames never accumulates) paired with the
  // wall-clock moment it was captured — `Date.now() - capturedAt` at
  // render time gives the true elapsed uptime, ticked smoothly every
  // second below rather than only on the ~2s frame cadence.
  const uptimeBaseRef = useRef<{ uptimeMs: number; capturedAt: number } | null>(null);
  const [, tickUptime] = useState(0);
  // The sustain-over-N-frames streak itself ALSO has to live in a ref, not
  // a hook: once `liveSeverity` settles at 'warn', every further frame
  // computes the same string and setState bails out — this component
  // simply never re-renders again for as long as usage stays flat at
  // 'warn'. A hook-based counter (one that only advances when its own
  // input prop changes between renders) would then never see those later
  // frames at all, so it could never reach `requiredSamples`. Counting
  // here, on every frame regardless of whether a render happens, is what
  // makes "sustained" mean "N consecutive frames," not "N consecutive
  // renders."
  const severityStreakRef = useRef<{ severity: Severity; count: number }>({ severity: 'none', count: 0 });
  const [liveSeverity, setLiveSeverity] = useState<Severity>('none');

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
      latestUsageRef.current = {
        memoryBytes: frame.memory_bytes,
        memoryLimitBytes: frame.memory_limit_bytes,
        cpuPercent: frame.cpu_percent,
        cpuLimitPercent: frame.cpu_limit_percent,
      };
      uptimeBaseRef.current = frame.state === 'running' ? { uptimeMs: frame.uptime_ms, capturedAt: Date.now() } : null;
      const raw = combineSeverity(memorySeverity(frame.memory_bytes, frame.memory_limit_bytes), cpuSeverity(frame.cpu_percent, frame.cpu_limit_percent));
      const streak = severityStreakRef.current;
      if (raw === streak.severity) streak.count += 1;
      else {
        streak.severity = raw;
        streak.count = 1;
      }
      setLiveSeverity(streak.count >= SUSTAINED_FRAMES ? raw : 'none');
    },
    onStatus: (data) => setPowerState(data.state),
  });

  const displayState = powerState ?? server?.powerState ?? 'offline';
  const connected = connectionState === 'open';

  // Ticks a re-render once a second so the uptime readout counts up
  // smoothly instead of only jumping on the ~2s stats-frame cadence.
  // Scoped to `running` only — stopped as soon as the server isn't, so
  // this never spends a timer counting up a number nobody's watching.
  useEffect(() => {
    if (displayState !== 'running') return;
    const id = setInterval(() => tickUptime((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [displayState]);

  const liveUptimeMs =
    displayState === 'running' && uptimeBaseRef.current
      ? uptimeBaseRef.current.uptimeMs + (Date.now() - uptimeBaseRef.current.capturedAt)
      : null;

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
          {liveUptimeMs != null && (
            <span className="inline-flex items-center gap-1.5 text-xs text-text-muted">
              <Clock className="h-3.5 w-3.5" aria-hidden="true" />
              Ativo há {formatUptime(liveUptimeMs)}
            </span>
          )}
        </div>
        <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${connected ? 'text-ok' : 'text-text-faint'}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-ok' : 'bg-text-faint'}`} />
          {CONN_LABEL[connectionState]}
        </span>
      </div>

      <PowerControls state={displayState} permissions={permissions} onAction={sendPower} />

      {lastError && <Alert>{lastError}</Alert>}

      {liveSeverity !== 'none' && latestUsageRef.current && (
        <ResourceAdvisory
          serverId={serverId}
          software={server?.software}
          // Already sustained above, over real frames rather than renders — 1 means "trust it immediately."
          requiredSamples={1}
          stats={buildLiveSnapshot(latestUsageRef.current, displayState)}
        />
      )}

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
