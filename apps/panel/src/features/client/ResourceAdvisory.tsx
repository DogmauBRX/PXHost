import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { ServerStatsSnapshot, SoftwareInfo } from '@/shared/api/types';
import { Alert } from '@/ui/primitives';
import { combineSeverity, cpuSeverity, dismiss, isDismissed, memorySeverity } from './advisory';
import { useSustainedSeverity } from './useSustainedSeverity';

interface ResourceAdvisoryProps {
  serverId: string;
  stats: ServerStatsSnapshot | undefined;
  software?: SoftwareInfo;
  /** WS frames arrive every 2s (~10s to sustain over 5); polled snapshots refresh every 60s (~2min over 2 samples). */
  requiredSamples: number;
}

/**
 * Fires only on genuinely high, SUSTAINED usage (see advisory.ts's
 * thresholds) — never on a single spike, never when the server isn't
 * running, and never twice in the same dismissal window. Renders nothing
 * in every other case, including while online/stats are still loading —
 * an advisory that flickers in and out during a page's first second would
 * itself be the annoyance this component exists to avoid.
 */
export function ResourceAdvisory({ serverId, stats, software, requiredSamples }: ResourceAdvisoryProps) {
  const [dismissedTick, setDismissedTick] = useState(0);

  const rawSeverity =
    stats?.online && stats.state === 'running'
      ? combineSeverity(memorySeverity(stats.memoryBytes, stats.memoryLimitBytes), cpuSeverity(stats.cpuPercent, stats.cpuLimitPercent))
      : 'none';
  const severity = useSustainedSeverity(rawSeverity, requiredSamples);

  // `dismissedTick` is never read below — it exists only so setting it
  // forces this render to re-run `isDismissed()`'s localStorage check,
  // since that read isn't itself reactive state.
  void dismissedTick;
  if (severity === 'none' || isDismissed(serverId, severity)) return null;

  const isCritical = severity === 'critical';
  const memPercent = stats?.memoryBytes && stats.memoryLimitBytes ? Math.round((stats.memoryBytes / stats.memoryLimitBytes) * 100) : null;

  const suggestions: string[] = [];
  if (software?.addonNoun === 'mod') suggestions.push('reduzir a quantidade de mods ou remover mods pesados');
  else if (software?.addonNoun === 'plugin') suggestions.push('revisar seus plugins — desative os que não usa');
  suggestions.push('reduzir a quantidade de jogadores simultâneos', 'aumentar a RAM alocada ao servidor');

  return (
    <Alert
      tone={isCritical ? 'fail' : 'warn'}
      title="⚠️ Atenção"
      onDismiss={() => {
        dismiss(serverId, severity);
        setDismissedTick((t) => t + 1);
      }}
    >
      <p>
        Seu servidor está utilizando {memPercent != null ? `${memPercent}%` : 'muito'} da memória disponível. Isso pode causar lentidão ou crashes.
      </p>
      <p className="mt-1">Considere:</p>
      <ul className="mt-1 list-inside list-disc space-y-0.5">
        {suggestions.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      <Link to="/client/plan" className="mt-2 inline-block font-medium underline">
        Ver planos
      </Link>
    </Alert>
  );
}
