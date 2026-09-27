import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { validateVariableValue } from './variable-rules';

/**
 * Strict customer-input resolution: every requested key must be a
 * variable the template actually declares, and BOTH `isUserViewable`
 * and `isUserEditable` — same posture `ServerVariablesService.update`
 * already takes for a customer editing an existing server's variables.
 * Unlike `ServersService.createOnNode`'s own inline loop (which quietly
 * ignores unknown keys, because that path also serves admin-driven
 * creation that may pass through incidental extra fields no template
 * declares), an UNKNOWN key here is rejected outright — a customer
 * typing/guessing an env var name they were never shown is a mistake to
 * surface, not silently drop.
 *
 * Moved here, unrenamed in behavior, from `OrdersService`'s own
 * `validateCheckoutVariables` (checkout no longer collects software
 * choices at all — see `CreateCheckoutDto`'s doc comment) — this is now
 * `ServerSetupService.complete`'s validator instead.
 */
export function resolveDeclaredVariables(
  templateVars: { envVariable: string; name: string; defaultValue: string; rules: string; isUserViewable: boolean; isUserEditable: boolean }[],
  requested: Record<string, string>,
): Record<string, string> {
  const byEnvVar = new Map(templateVars.map((tv) => [tv.envVariable, tv]));

  for (const [key, value] of Object.entries(requested)) {
    const tv = byEnvVar.get(key);
    if (!tv) throw new BadRequestException(`Variável desconhecida: ${key}`);
    if (!tv.isUserViewable || !tv.isUserEditable) throw new ForbiddenException(`Variável não configurável: ${key}`);
    const error = validateVariableValue(value, tv.rules);
    if (error) throw new BadRequestException(`${tv.name}: ${error}`);
  }

  const resolved: Record<string, string> = {};
  for (const tv of templateVars) {
    resolved[tv.envVariable] = requested[tv.envVariable] ?? tv.defaultValue;
  }
  return resolved;
}

const MIN_HEAP_MB = 512;
const MIN_JVM_HEADROOM_MB = 512;
const JVM_HEADROOM_RATIO = 0.15;

/**
 * The -Xmx for a container whose cgroup limit is `memoryMb`. The JVM uses
 * memory beyond the heap (metaspace, threads, GC, native buffers), so a heap
 * equal to the limit gets the container OOM-killed under load — found live
 * with All the Mods 10 on a 6 GB plan.
 */
export function jvmHeapMb(memoryMb: number): number {
  const headroom = Math.max(MIN_JVM_HEADROOM_MB, Math.ceil(memoryMb * JVM_HEADROOM_RATIO));
  return Math.max(MIN_HEAP_MB, memoryMb - headroom);
}

/**
 * Resource variables are owned by the server's snapshotted plan limits,
 * never by a template default. Templates still declare SERVER_MEMORY so
 * their startup command can substitute it, but the value must follow the
 * server row that also drives Docker's cgroup limit.
 */
export function applyPlanManagedVariables(values: Record<string, string>, memoryMb: number): Record<string, string> {
  if (Object.prototype.hasOwnProperty.call(values, 'SERVER_MEMORY')) {
    values.SERVER_MEMORY = String(jvmHeapMb(memoryMb));
  }
  return values;
}
