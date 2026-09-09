import { amountToCents, centsToAmount } from './money';

describe('centsToAmount', () => {
  it('converts integer cents to the decimal amount Mercado Pago expects', () => {
    expect(centsToAmount(3990)).toBe(39.9);
    expect(centsToAmount(100)).toBe(1);
    expect(centsToAmount(1)).toBe(0.01);
    expect(centsToAmount(0)).toBe(0);
  });
});

describe('amountToCents', () => {
  it('converts a decimal amount back to integer cents', () => {
    expect(amountToCents(39.9)).toBe(3990);
    expect(amountToCents(1)).toBe(100);
  });

  it('absorbs floating-point noise by rounding to the nearest cent', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE754 — a naive *100 would
    // yield 30.000000000000004, not the integer 30 a cents column needs.
    expect(amountToCents(0.1 + 0.2)).toBe(30);
  });
});

describe('round trip', () => {
  it('cents -> amount -> cents recovers the original value for realistic prices', () => {
    for (const cents of [0, 1, 99, 100, 3990, 12345, 999999]) {
      expect(amountToCents(centsToAmount(cents))).toBe(cents);
    }
  });
});
