import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Terminal as XTerm } from '@xterm/xterm';
import { Check, Clock, Copy, Link2, RefreshCw, Server, Settings2, Wifi } from 'lucide-react';
import { getServer, getServerDiskUsage } from '@/features/servers/servers.api';
import { listServerVariables } from '@/features/variables/variables.api';
import { updateServerHostname } from '@/features/variables/hostname.api';
import { powerStateLabel } from '@/features/servers/status-labels';
import { useServerSocket } from '@/shared/realtime/useServerSocket';
import { ApiError } from '@/shared/api/client';
import { formatBytes } from '@/shared/format/datetime';
import { Terminal } from './Terminal';
import { PowerControls } from './PowerControls';
import { cpuSeverity, memorySeverity, type Severity } from '@/features/client/advisory';
import { Alert, Button, Card, CardBody, Gauge, Input, StatusBadge, type GaugeHandle } from '@/ui/primitives';

// Same three-tone vocabulary Gauge/Meter already use — 'warn'/'critical'
// from advisory.ts's Severity just needed renaming to line up with it.
function severityToTone(s: Severity): 'normal' | 'warning' | 'critical' {
  if (s === 'critical') return 'critical';
  if (s === 'warn') return 'warning';
  return 'normal';
}
const STATUS_LABEL: Record<'normal' | 'warning' | 'critical', string> = {
  normal: 'Normal',
  warning: 'Elevado',
  critical: 'Crítico',
};

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

const CONN_LABEL: Record<string, string> = {
  idle: 'Iniciando…',
  connecting: 'Conectando…',
  authenticating: 'Autenticando…',
  open: 'Conectado',
  reconnecting: 'Reconectando…',
  failed: 'Falha na conexão',
};

export function ConsolePage({ serverId }: { serverId: string }) {
  const queryClient = useQueryClient();
  const { data: server } = useQuery({ queryKey: ['server', serverId], queryFn: () => getServer(serverId) });
  // Same query VariablesPage already makes (shares its cache when the
  // customer has visited both tabs) — MINECRAFT_VERSION is always
  // present in this list even though VariablesPage's own UI hides it
  // from the editable fields (superseded there by "Trocar versão").
  const { data: variables } = useQuery({ queryKey: ['server-variables', serverId], queryFn: () => listServerVariables(serverId) });
  const minecraftVersion = variables?.find((v) => v.envVariable === 'MINECRAFT_VERSION')?.value;
  const [powerState, setPowerState] = useState<string | null>(null);
  const [command, setCommand] = useState('');
  const [editingHostname, setEditingHostname] = useState(false);
  const [hostnameDraft, setHostnameDraft] = useState('');
  const [hostnameError, setHostnameError] = useState<string | null>(null);
  const [addressCopied, setAddressCopied] = useState(false);
  const termRef = useRef<XTerm | null>(null);
  const cpuGaugeRef = useRef<GaugeHandle>(null);
  const ramGaugeRef = useRef<GaugeHandle>(null);
  const diskGaugeRef = useRef<GaugeHandle>(null);

  // The agent's own `uptime_ms` (re-synced from every frame, so client
  // clock drift between frames never accumulates) paired with the
  // wall-clock moment it was captured — `Date.now() - capturedAt` at
  // render time gives the true elapsed uptime, ticked smoothly every
  // second below rather than only on the ~2s frame cadence.
  const uptimeBaseRef = useRef<{ uptimeMs: number; capturedAt: number } | null>(null);
  const [, tickUptime] = useState(0);

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
      setPowerState(frame.state);
      uptimeBaseRef.current = frame.state === 'running' ? { uptimeMs: frame.uptime_ms, capturedAt: Date.now() } : null;

      // Gauge fill is "% of what THIS server is allowed to use," the same
      // ratio cpuSeverity/memorySeverity already threshold against — not
      // raw cpu_percent, which can read past 100 on a multi-core limit.
      const cpuTone = severityToTone(cpuSeverity(frame.cpu_percent, frame.cpu_limit_percent));
      const cpuPct = frame.cpu_limit_percent > 0 ? (frame.cpu_percent / frame.cpu_limit_percent) * 100 : 0;
      cpuGaugeRef.current?.update(cpuPct, cpuTone, `${Math.round(cpuPct)}%`, `${frame.cpu_percent.toFixed(1)}% / ${frame.cpu_limit_percent}% · ${STATUS_LABEL[cpuTone]}`);

      const memTone = severityToTone(memorySeverity(frame.memory_bytes, frame.memory_limit_bytes));
      const memPct = frame.memory_limit_bytes > 0 ? (frame.memory_bytes / frame.memory_limit_bytes) * 100 : 0;
      ramGaugeRef.current?.update(memPct, memTone, `${Math.round(memPct)}%`, `${formatBytes(frame.memory_bytes)} / ${formatBytes(frame.memory_limit_bytes)} · ${STATUS_LABEL[memTone]}`);
    },
    onStatus: (data) => setPowerState(data.state),
  });

  const displayState = powerState ?? server?.powerState ?? 'offline';
  const connected = connectionState === 'open';
  const canEditHostname = server?.permissions.includes('hostname.update') ?? false;

  async function copyPublicAddress() {
    if (!server?.publicAddress) return;
    try {
      await navigator.clipboard.writeText(server.publicAddress);
      setAddressCopied(true);
      window.setTimeout(() => setAddressCopied(false), 2_000);
    } catch {
      // The address remains visible and selectable when the browser blocks
      // clipboard access (for example, on an insecure custom origin).
    }
  }

  const hostnameMutation = useMutation({
    mutationFn: (hostname: string | null) => updateServerHostname(serverId, hostname),
    onSuccess: () => {
      setEditingHostname(false);
      setHostnameError(null);
      void queryClient.invalidateQueries({ queryKey: ['server', serverId] });
    },
    onError: (error) => setHostnameError(error instanceof ApiError ? error.message : 'Não foi possível salvar o endereço.'),
  });

  // On-demand only — disk usage is a real filesystem walk on the agent
  // (see ClientServersService.diskUsage's doc comment), not part of the
  // live stats stream, so there's no onStats-driven update for it. A
  // button triggers this; nothing polls it.
  const diskUsageMutation = useMutation({
    mutationFn: () => getServerDiskUsage(serverId),
    onSuccess: (snapshot) => {
      if (snapshot.usedBytes == null || snapshot.limitBytes == null) {
        diskGaugeRef.current?.update(0, 'normal', '—', 'Não foi possível medir agora');
        return;
      }
      if (snapshot.limitBytes <= 0) {
        diskGaugeRef.current?.update(0, 'normal', formatBytes(snapshot.usedBytes), `${formatBytes(snapshot.usedBytes)} usados · sem limite`);
        return;
      }
      const tone = severityToTone(memorySeverity(snapshot.usedBytes, snapshot.limitBytes));
      const pct = (snapshot.usedBytes / snapshot.limitBytes) * 100;
      diskGaugeRef.current?.update(pct, tone, `${Math.round(pct)}%`, `${formatBytes(snapshot.usedBytes)} / ${formatBytes(snapshot.limitBytes)} · ${STATUS_LABEL[tone]}`);
    },
    onError: () => {
      diskGaugeRef.current?.update(0, 'normal', '—', 'Falha ao medir');
    },
  });

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

  function openHostnameEditor() {
    setHostnameDraft(server?.customHostname ?? '');
    setHostnameError(null);
    setEditingHostname(true);
  }

  function saveHostname(e: FormEvent) {
    e.preventDefault();
    const hostname = hostnameDraft.trim();
    if (hostname === (server?.customHostname ?? '')) {
      setEditingHostname(false);
      return;
    }
    hostnameMutation.mutate(hostname === '' ? null : hostname);
  }

  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-card border border-border bg-surface shadow-xs">
        <div className="flex flex-col gap-5 p-5 sm:p-6">
          <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
            <div className="flex min-w-0 items-start gap-3">
              <div className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/12 text-accent-strong">
                <Server className="h-5 w-5" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2.5">
                  <h1 className="truncate text-2xl font-semibold tracking-tight text-text">{server?.name ?? '…'}</h1>
                  <StatusBadge status={displayState} label={powerStateLabel(displayState)} />
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-text-muted">
                  {server?.template && <span className="font-medium text-text-muted">{server.template.name}{minecraftVersion ? ` ${minecraftVersion}` : ''}</span>}
                  {liveUptimeMs != null && <span className="inline-flex items-center gap-1.5"><Clock className="h-4 w-4" aria-hidden="true" />Ativo há {formatUptime(liveUptimeMs)}</span>}
                </div>
              </div>
            </div>
            <span className={`inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold ${connected ? 'border-ok/25 bg-ok/10 text-ok' : 'border-border bg-surface-2 text-text-faint'}`}>
              <Wifi className="h-3.5 w-3.5" aria-hidden="true" />
              {CONN_LABEL[connectionState]}
            </span>
          </div>

          {server?.publicAddress && (
            <div className="relative flex flex-col gap-3 rounded-xl border border-border bg-surface-2/65 p-3.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-2.5">
                <Link2 className="h-4 w-4 shrink-0 text-accent-strong" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-xs font-medium text-text-faint">Endereço para conexão</p>
                  <p className="truncate font-mono text-sm font-semibold text-text">{server.publicAddress}</p>
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => void copyPublicAddress()}>
                  {addressCopied ? <Check className="h-4 w-4 text-ok" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
                  {addressCopied ? 'Copiado' : 'Copiar endereço'}
                </Button>
                {canEditHostname && (
                  <button
                    type="button"
                    onClick={openHostnameEditor}
                    className="inline-flex items-center gap-1.5 px-1 text-xs font-semibold text-accent-strong transition hover:text-accent"
                  >
                    <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
                    {server.customHostname ? 'Alterar endereço' : 'Personalizar endereço'}
                  </button>
                )}
              </div>
              {editingHostname && (
                <form
                  onSubmit={saveHostname}
                  className="absolute inset-0 z-10 flex flex-col justify-center gap-3 rounded-xl border border-accent/35 bg-surface p-3.5 shadow-lg sm:flex-row sm:items-center"
                >
                  <div className="min-w-0 flex-1">
                    <label htmlFor="console-custom-hostname" className="text-xs font-semibold text-text">Subdomínio personalizado</label>
                    <div className="mt-1 flex items-center gap-2">
                      <Input
                        id="console-custom-hostname"
                        autoFocus
                        value={hostnameDraft}
                        disabled={hostnameMutation.isPending}
                        onChange={(event) => { setHostnameDraft(event.target.value.toLowerCase()); setHostnameError(null); }}
                        placeholder="survival"
                        aria-describedby="console-hostname-hint"
                      />
                      <span className="hidden whitespace-nowrap text-xs text-text-faint sm:inline">Apenas o subdomínio</span>
                    </div>
                    <p id="console-hostname-hint" className={`mt-1 text-xs ${hostnameError ? 'text-fail' : 'text-text-faint'}`}>
                      {hostnameError ?? 'Use letras minúsculas, números e hífens. Deixe vazio para remover.'}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2 sm:self-end">
                    <Button type="button" variant="ghost" size="sm" disabled={hostnameMutation.isPending} onClick={() => setEditingHostname(false)}>Cancelar</Button>
                    <Button type="submit" variant="primary" size="sm" disabled={hostnameMutation.isPending}>
                      {hostnameMutation.isPending ? 'Salvando…' : 'Salvar endereço'}
                    </Button>
                  </div>
                </form>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-3 border-t border-border bg-surface-2/35 px-5 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-sm font-semibold text-text">Controles de energia</p>
            <p className="mt-0.5 text-xs text-text-faint">As ações são aplicadas imediatamente ao servidor.</p>
          </div>
          <PowerControls state={displayState} permissions={permissions} onAction={sendPower} />
        </div>
      </section>

      {lastError && <Alert>{lastError}</Alert>}

      <Card>
        <CardBody className="flex flex-wrap justify-around gap-6">
          <Gauge ref={cpuGaugeRef} label="CPU" />
          <Gauge ref={ramGaugeRef} label="RAM" />
          <div className="flex flex-1 flex-col items-center gap-2">
            <Gauge ref={diskGaugeRef} label="Armazenamento" initialDetailText="Nunca medido" />
            <Button variant="ghost" size="sm" disabled={diskUsageMutation.isPending} onClick={() => diskUsageMutation.mutate()}>
              <RefreshCw className={`h-3.5 w-3.5 ${diskUsageMutation.isPending ? 'animate-spin' : ''}`} aria-hidden="true" />
              {diskUsageMutation.isPending ? 'Medindo…' : 'Atualizar'}
            </Button>
          </div>
        </CardBody>
      </Card>

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
