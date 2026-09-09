import { Server } from 'lucide-react';

/**
 * The landing page's second hero animation — a mock server card whose
 * CPU/RAM/Storage bars climb from empty to a target level, then the
 * server reports "ONLINE," then it resets and loops. Pure CSS
 * `@keyframes` on a shared 6s timeline (no JS), same posture as
 * `NetworkAnimation.tsx`. Purely illustrative (`aria-hidden`, fixed
 * example numbers, no real telemetry) — this is a demonstration of what
 * provisioning FEELS like, not a claim about any specific server's real
 * usage, and must never be mistaken for the real per-server stats the
 * authenticated console shows.
 */
const BARS = [
  { key: 'cpu', label: 'CPU', value: '72%' },
  { key: 'ram', label: 'RAM', value: '4.4 GB / 8 GB' },
  { key: 'storage', label: 'Armazenamento', value: '19 GB / 50 GB' },
] as const;

export function ServerProvisionAnimation() {
  return (
    <div className="mx-auto w-full max-w-sm overflow-hidden rounded-card border border-border bg-surface shadow-sm" aria-hidden="true">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-text-muted" aria-hidden="true" />
          <span className="font-mono text-sm text-text">SERVER-NODE</span>
        </div>
        <span className="provision-badge inline-flex items-center gap-1.5 rounded-full bg-ok-tint px-2.5 py-1 text-xs font-semibold text-ok">
          <span className="h-1.5 w-1.5 rounded-full bg-ok" />
          ONLINE
        </span>
      </div>

      <div className="space-y-4 p-4">
        {BARS.map((bar) => (
          <div key={bar.key}>
            <div className="flex items-center justify-between text-xs text-text-muted">
              <span>{bar.label}</span>
              <span className="font-mono">{bar.value}</span>
            </div>
            <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-surface-2">
              <div className={`h-full rounded-full bg-gradient-to-r from-accent to-accent-strong provision-bar-${bar.key}`} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
