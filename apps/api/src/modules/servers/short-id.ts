import { randomBytes } from 'node:crypto';

// Crockford base32 (no I, L, O, U — avoids visual confusion), matching
// architecture doc 2.1's short_id: used as the container name suffix and
// SFTP username by the agent, so it must be short, typeable, and never
// ambiguous when read aloud or hand-copied.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateShortId(): string {
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}
