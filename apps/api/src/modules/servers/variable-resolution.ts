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

/**
 * Resource variables are owned by the server's snapshotted plan limits,
 * never by a template default. Templates still declare SERVER_MEMORY so
 * their startup command can substitute it, but the value must follow the
 * server row that also drives Docker's cgroup limit.
 */
export function applyPlanManagedVariables(values: Record<string, string>, memoryMb: number): Record<string, string> {
  if (Object.prototype.hasOwnProperty.call(values, 'SERVER_MEMORY')) {
    values.SERVER_MEMORY = String(memoryMb);
  }
  return values;
}
