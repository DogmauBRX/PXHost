import { isReservedHostnameLabel, isValidHostnameLabelFormat } from './hostname-policy';

describe('isValidHostnameLabelFormat', () => {
  it('accepts a plain lowercase alphanumeric label', () => {
    expect(isValidHostnameLabelFormat('survival')).toBe(true);
  });

  it('accepts internal hyphens', () => {
    expect(isValidHostnameLabelFormat('minecraft-do-joao')).toBe(true);
  });

  it('rejects a label shorter than the minimum', () => {
    expect(isValidHostnameLabelFormat('ab')).toBe(false);
  });

  it('rejects a label longer than the maximum', () => {
    expect(isValidHostnameLabelFormat('a'.repeat(33))).toBe(false);
  });

  it('accepts a label at exactly the maximum length', () => {
    expect(isValidHostnameLabelFormat('a'.repeat(32))).toBe(true);
  });

  it('rejects uppercase (callers must lowercase before validating, same as deriveHostname/deriveCustomHostname)', () => {
    expect(isValidHostnameLabelFormat('Survival')).toBe(false);
  });

  it('rejects a leading hyphen — invalid as a real DNS label, unlike Location.shortCode\'s looser pattern', () => {
    expect(isValidHostnameLabelFormat('-survival')).toBe(false);
  });

  it('rejects a trailing hyphen', () => {
    expect(isValidHostnameLabelFormat('survival-')).toBe(false);
  });

  it('rejects spaces', () => {
    expect(isValidHostnameLabelFormat('sur vival')).toBe(false);
  });

  it('rejects dots (a label is one segment, not a full hostname)', () => {
    expect(isValidHostnameLabelFormat('survival.gxhost')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isValidHostnameLabelFormat('')).toBe(false);
  });
});

describe('isReservedHostnameLabel', () => {
  it('rejects known infra subdomains', () => {
    expect(isReservedHostnameLabel('www')).toBe(true);
    expect(isReservedHostnameLabel('api')).toBe(true);
    expect(isReservedHostnameLabel('node01')).toBe(true);
    expect(isReservedHostnameLabel('mc')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isReservedHostnameLabel('WWW')).toBe(true);
    expect(isReservedHostnameLabel('Api')).toBe(true);
  });

  it('allows an ordinary, non-reserved label', () => {
    expect(isReservedHostnameLabel('survival')).toBe(false);
  });
});
