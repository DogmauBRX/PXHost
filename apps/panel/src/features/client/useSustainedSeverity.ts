import { useEffect, useRef, useState } from 'react';
import type { Severity } from './advisory';

/**
 * Only reports a severity once it has held for `requiredSamples`
 * consecutive calls — a single spike (a GC pause, a world-save tick) must
 * never surface an alert. Resets the streak the moment severity drops or
 * changes, so escalating from 'warn' to 'critical' has to earn its own streak too.
 */
export function useSustainedSeverity(current: Severity, requiredSamples: number): Severity {
  const streakRef = useRef<{ severity: Severity; count: number }>({ severity: 'none', count: 0 });
  const [sustained, setSustained] = useState<Severity>('none');

  useEffect(() => {
    const streak = streakRef.current;
    if (current === streak.severity) {
      streak.count += 1;
    } else {
      streak.severity = current;
      streak.count = 1;
    }
    setSustained(streak.count >= requiredSamples ? current : 'none');
  }, [current, requiredSamples]);

  return sustained;
}
