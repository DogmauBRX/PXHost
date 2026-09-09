import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RedisService } from '../../core/redis/redis.service';

const CACHE_KEY = 'public:templates:v1';
const CACHE_TTL_SECONDS = 60;

export type PublicTemplateOptionKind = 'text' | 'integer' | 'boolean' | 'choice';

export interface PublicTemplateOption {
  envVariable: string;
  name: string;
  description: string | null;
  defaultValue: string;
  kind: PublicTemplateOptionKind;
  required: boolean;
  min?: number;
  max?: number;
  choices?: string[];
}

export interface PublicTemplate {
  id: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  softwareKind: string | null;
  group: { id: string; name: string; iconUrl: string | null };
  options: PublicTemplateOption[];
}

/**
 * The catalog a customer picks a template from at checkout — a small,
 * deliberately narrow read-only view over `ServerTemplate`. Never
 * `installScript`, `configFiles`/`configStartup`/`configLogs`,
 * `dockerImages`, `installImage`/`installEntrypoint`, or anything
 * node-shaped — those stay admin-only (`TemplatesController`), same
 * posture `PLAN_PUBLIC_SELECT` already documents for `Plan`.
 *
 * Only `isPublic && isActive && deletedAt: null` templates are ever
 * returned — `isPublic` gates "may a customer choose this at all"
 * (payments plan §1: default false, an admin opts each template in
 * explicitly), `isActive` gates "is this template even usable right now"
 * (an admin-wide kill switch, e.g. a broken install script).
 *
 * `options` turns each customer-editable `TemplateVariable`
 * (`isUserViewable && isUserEditable`) into a form-ready field, deriving
 * `kind`/`required`/`min`/`max`/`choices` from the SAME `rules` string
 * `variable-rules.ts` already enforces server-side — the checkout step
 * that reads this response and the validator that later checks the
 * submitted values can never disagree about what a field allows, because
 * there's exactly one source (`rules`), not two.
 */
@Injectable()
export class PublicTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** Same invalidate-on-write, self-heal-within-TTL posture as `PublicPlansService.invalidateCache` — a failed Redis call here must never fail the admin edit that triggered it. */
  async invalidateCache(): Promise<void> {
    await this.redis.client.del(CACHE_KEY).catch(() => undefined);
  }

  async list(): Promise<PublicTemplate[]> {
    const cached = await this.redis.client.get(CACHE_KEY).catch(() => null);
    if (cached) return JSON.parse(cached);

    const templates = await this.prisma.serverTemplate.findMany({
      where: { deletedAt: null, isPublic: true, isActive: true },
      select: {
        id: true,
        name: true,
        description: true,
        iconUrl: true,
        softwareKind: true,
        group: { select: { id: true, name: true, iconUrl: true } },
        variables: {
          where: { isUserViewable: true, isUserEditable: true },
          orderBy: { sortOrder: 'asc' },
          select: { envVariable: true, name: true, description: true, defaultValue: true, rules: true },
        },
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });

    const result: PublicTemplate[] = templates.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      iconUrl: t.iconUrl,
      softwareKind: t.softwareKind,
      group: t.group,
      options: t.variables.map((v) => ({
        envVariable: v.envVariable,
        name: v.name,
        description: v.description,
        defaultValue: v.defaultValue,
        ...deriveOptionShape(v.rules),
      })),
    }));

    await this.redis.client.set(CACHE_KEY, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS).catch(() => undefined);
    return result;
  }
}

/**
 * Reads the exact same Laravel-style rule tokens `variable-rules.ts`
 * validates against (`required`, `integer`, `boolean`, `min:N`, `max:N`,
 * `in:a,b,c`) and turns them into a form-field shape. Unrecognized tokens
 * are ignored here too, mirroring that file's own "never brick a template
 * over a rule written for a future validator version" posture.
 */
function deriveOptionShape(rules: string): Pick<PublicTemplateOption, 'kind' | 'required' | 'min' | 'max' | 'choices'> {
  const tokens = rules.split('|').map((t) => t.trim()).filter(Boolean);
  const required = tokens.includes('required');

  const inToken = tokens.find((t) => t.startsWith('in:'));
  if (inToken) {
    return { kind: 'choice', required, choices: inToken.slice('in:'.length).split(',') };
  }
  if (tokens.includes('boolean')) {
    return { kind: 'boolean', required };
  }
  if (tokens.includes('integer')) {
    const min = tokens.find((t) => t.startsWith('min:'));
    const max = tokens.find((t) => t.startsWith('max:'));
    return {
      kind: 'integer',
      required,
      min: min ? Number(min.slice('min:'.length)) : undefined,
      max: max ? Number(max.slice('max:'.length)) : undefined,
    };
  }
  return { kind: 'text', required };
}
