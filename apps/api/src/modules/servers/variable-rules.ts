// A minimal Laravel-style rule-string validator — the same `rules` column
// TemplatesService already lets an admin write freely (e.g.
// 'required|integer|min:512'), now actually enforced on the one write path
// a customer can reach (server-variables.service.ts). Unrecognized tokens
// are ignored rather than rejected: a rule an admin wrote for a future
// version of this validator should never brick every server using that
// template in the meantime.
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
