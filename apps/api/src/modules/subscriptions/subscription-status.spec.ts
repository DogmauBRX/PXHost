import { ConflictException } from '@nestjs/common';
import { assertTransition, canTransition, nextPeriodEnd, SUBSCRIPTION_STATUSES, SubscriptionStatus } from './subscription-status';

describe('canTransition', () => {
  it('allows pending -> active (the only admin-activation path)', () => {
    expect(canTransition('pending', 'active')).toBe(true);
  });

  it('allows pending -> cancelled (customer or admin calls it off before it ever started)', () => {
    expect(canTransition('pending', 'cancelled')).toBe(true);
  });

  it('never allows pending -> past_due or pending -> suspended (a pending subscription was never billing, so it cannot lapse)', () => {
    expect(canTransition('pending', 'past_due')).toBe(false);
    expect(canTransition('pending', 'suspended')).toBe(false);
  });

  it('allows active to lapse into past_due or suspended, and to be cancelled or expired', () => {
    expect(canTransition('active', 'past_due')).toBe(true);
    expect(canTransition('active', 'suspended')).toBe(true);
    expect(canTransition('active', 'cancelled')).toBe(true);
    expect(canTransition('active', 'expired')).toBe(true);
  });

  it('allows past_due and suspended to recover back to active', () => {
    expect(canTransition('past_due', 'active')).toBe(true);
    expect(canTransition('suspended', 'active')).toBe(true);
  });

  it('cancelled and expired are terminal — no edge leaves either', () => {
    const terminal: SubscriptionStatus[] = ['cancelled', 'expired'];
    for (const from of terminal) {
      for (const to of SUBSCRIPTION_STATUSES) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it('every status is reflexive-false — a transition to the same status is not a defined move', () => {
    for (const status of SUBSCRIPTION_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });
});

describe('assertTransition', () => {
  it('throws a ConflictException prefixed INVALID_TRANSITION: for an illegal move', () => {
    expect(() => assertTransition('cancelled', 'active')).toThrow(ConflictException);
    try {
      assertTransition('cancelled', 'active');
      fail('expected assertTransition to throw');
    } catch (err) {
      expect((err as Error).message).toMatch(/^INVALID_TRANSITION:/);
    }
  });

  it('does not throw for a legal move', () => {
    expect(() => assertTransition('pending', 'active')).not.toThrow();
  });
});

describe('nextPeriodEnd', () => {
  it('adds one month for monthly', () => {
    expect(nextPeriodEnd(new Date('2026-01-15T00:00:00Z'), 'monthly').toISOString()).toBe('2026-02-15T00:00:00.000Z');
  });

  it('adds three months for quarterly', () => {
    expect(nextPeriodEnd(new Date('2026-01-15T00:00:00Z'), 'quarterly').toISOString()).toBe('2026-04-15T00:00:00.000Z');
  });

  it('adds six months for semiannual', () => {
    expect(nextPeriodEnd(new Date('2026-01-15T00:00:00Z'), 'semiannual').toISOString()).toBe('2026-07-15T00:00:00.000Z');
  });

  it('adds twelve months for annual', () => {
    expect(nextPeriodEnd(new Date('2026-01-15T00:00:00Z'), 'annual').toISOString()).toBe('2027-01-15T00:00:00.000Z');
  });

  it('rolls over year and month boundaries correctly', () => {
    expect(nextPeriodEnd(new Date('2026-12-20T00:00:00Z'), 'monthly').toISOString()).toBe('2027-01-20T00:00:00.000Z');
  });
});
