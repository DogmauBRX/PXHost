import { isValidCpf, normalizeCpf } from './cpf.util';

describe('normalizeCpf', () => {
  it('strips punctuation, keeping only digits', () => {
    expect(normalizeCpf('529.982.247-25')).toBe('52998224725');
  });
});

describe('isValidCpf', () => {
  it('accepts a real CPF, with or without punctuation', () => {
    expect(isValidCpf('52998224725')).toBe(true);
    expect(isValidCpf('529.982.247-25')).toBe(true);
    expect(isValidCpf('11144477735')).toBe(true);
  });

  it('rejects a CPF with a wrong check digit', () => {
    expect(isValidCpf('52998224726')).toBe(false);
  });

  it('rejects a CPF that is not 11 digits', () => {
    expect(isValidCpf('1234567890')).toBe(false);
    expect(isValidCpf('123456789012')).toBe(false);
    expect(isValidCpf('')).toBe(false);
  });

  it('rejects every all-same-digit sequence, even though the naive checksum accepts them', () => {
    for (let d = 0; d <= 9; d++) {
      expect(isValidCpf(String(d).repeat(11))).toBe(false);
    }
  });
});
