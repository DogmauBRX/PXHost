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

/**
 * Custom hostnames and automatic ones share the `.mc.` namespace since
 * `deriveCustomHostname` stopped composing at the apex (which the
 * platform cannot publish). Claiming a label shaped like some server's
 * shortId would be claiming that server's address.
 */
describe('labels com forma de shortId', () => {
  it('reserva um label que é exatamente um shortId', () => {
    expect(isReservedHostnameLabel('tdafy4cn')).toBe(true);
    expect(isReservedHostnameLabel('TDAFY4CN')).toBe(true);
  });

  // O alfabeto do shortId omite i, l, o e u de propósito (ambíguos ao
  // ler em voz alta), então um label de 8 letras que contenha um deles
  // não tem como ser um shortId.
  it('não reserva um nome comum de 8 letras que contenha uma letra fora do alfabeto', () => {
    expect(isReservedHostnameLabel('survival')).toBe(false); // tem i e u
    expect(isReservedHostnameLabel('creative')).toBe(false); // tem i
  });

  it('não reserva por tamanho — só a forma exata de 8 conta', () => {
    expect(isReservedHostnameLabel('tdafy4c')).toBe(false);
    expect(isReservedHostnameLabel('tdafy4cnn')).toBe(false);
  });
});
