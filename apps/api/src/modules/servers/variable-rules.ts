// A minimal Laravel-style rule-string validator — the same `rules` column
// TemplatesService already lets an admin write freely (e.g.
// 'required|integer|min:512'), now actually enforced on the one write path
// a customer can reach (server-variables.service.ts). Unrecognized tokens
// are ignored rather than rejected: a rule an admin wrote for a future
// version of this validator should never brick every server using that
// template in the meantime.

export type VariableOptionKind = 'text' | 'integer' | 'boolean' | 'choice';

export interface VariableOptionShape {
  kind: VariableOptionKind;
  required: boolean;
  min?: number;
  max?: number;
  choices?: string[];
}

/**
 * Reads the exact same Laravel-style rule tokens `validateVariableValue`
 * below validates against (`required`, `integer`, `boolean`, `min:N`,
 * `max:N`, `in:a,b,c`) and turns them into a form-field shape — one
 * source of truth for "what kind of input does this rules string
 * describe," shared by the pre-purchase checkout catalog
 * (public-templates.service.ts) and the post-purchase Configurações tab
 * (server-variables.service.ts), so the two can never disagree about
 * whether a field renders as a dropdown. Unrecognized tokens are
 * ignored here too, mirroring `validateVariableValue`'s own "never brick
 * a template over a rule written for a future validator version" posture.
 */
export function deriveVariableOptionShape(rules: string): VariableOptionShape {
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
export function validateVariableValue(value: string, rules: string): string | null {
  const tokens = rules.split('|').map((t) => t.trim()).filter(Boolean);
  const nullable = tokens.includes('nullable');
  const required = tokens.includes('required');

  if (value === '') {
    if (required && !nullable) return 'é obrigatório.';
    return null;
  }

  for (const token of tokens) {
    const [name, arg] = token.split(':');
    switch (name) {
      case 'integer': {
        if (!/^-?\d+$/.test(value)) return 'deve ser um número inteiro.';
        break;
      }
      case 'boolean': {
        if (!['true', 'false', '0', '1'].includes(value)) return 'deve ser verdadeiro ou falso.';
        break;
      }
      case 'max': {
        const max = Number(arg);
        const n = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : null;
        if (n !== null && tokens.includes('integer')) {
          if (n > max) return `deve ser no máximo ${max}.`;
        } else if (value.length > max) {
          return `deve ter no máximo ${max} caracteres.`;
        }
        break;
      }
      case 'min': {
        const min = Number(arg);
        const n = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : null;
        if (n !== null && tokens.includes('integer')) {
          if (n < min) return `deve ser no mínimo ${min}.`;
        } else if (value.length < min) {
          return `deve ter no mínimo ${min} caracteres.`;
        }
        break;
      }
      case 'in': {
        const allowed = (arg ?? '').split(',');
        if (!allowed.includes(value)) return `deve ser um dos seguintes valores: ${allowed.join(', ')}.`;
        break;
      }
      default:
        break;
    }
  }
  return null;
}
