/**
 * CPF (Brazilian tax ID) normalization and validation. Standard two
 * check-digit algorithm — but the naive checksum alone lets sequences
 * like "00000000000"/"11111111111" through (all digits equal always
 * produces valid check digits under this algorithm), so those are
 * rejected explicitly even though they'd otherwise pass.
 */

export function normalizeCpf(raw: string): string {
  return raw.replace(/\D/g, '');
}

function checkDigit(digits: string, weightStart: number): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    sum += Number(digits[i]) * (weightStart - i);
  }
  const remainder = sum % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

export function isValidCpf(raw: string): boolean {
  const cpf = normalizeCpf(raw);
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  const firstCheck = checkDigit(cpf.slice(0, 9), 10);
  if (firstCheck !== Number(cpf[9])) return false;

  const secondCheck = checkDigit(cpf.slice(0, 10), 11);
  if (secondCheck !== Number(cpf[10])) return false;

  return true;
}
