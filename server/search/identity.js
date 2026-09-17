/**
 * Magnet/hash identity normalization: one canonical lowercase hex form from
 * base32 or hex inputs, for deterministic deduplication across providers.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Normalize any magnet identity input to a canonical form.
 * Returns { hash, canonical } or null when the input carries no extractable
 * identity. hex stays lowercase hex; base32 (RFC4648, btih) converts to hex.
 * Returns null rather than guessing for malformed inputs.
 */
export function normalizeMagnetHash(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();

  // magnet:?xt=urn:btih:<HASH>
  let xt = null;
  if (trimmed.toLowerCase().startsWith('magnet:')) {
    const match = /xt=urn:btih:([^&]+)/i.exec(trimmed);
    if (!match) return null;
    xt = decodeURIComponent(match[1]);
  } else {
    xt = trimmed.trim();
  }

  if (!xt) return null;

  if (/^[a-fA-F0-9]{40}$/.test(xt)) {
    return { hash: xt.toLowerCase(), encoding: 'hex' };
  }

  if (/^[A-Za-z2-7]{32}$/.test(xt)) {
    return { hash: base32ToHex(xt.toUpperCase()), encoding: 'base32' };
  }

  return null;
}

/**
 * Convert 32-char RFC4648 base32 to 40-char lowercase hex.
 */
export function base32ToHex(base32) {
  let bits = 0;
  let value = 0;
  const bytes = [];

  for (const char of base32) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }

  if (bytes.length !== 20) return null;
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Extract an identity from a raw input (magnet URL, hash, or infohash).
 * Convenience wrapper returning just the canonical hash or null.
 */
export function canonicalIdentity(input) {
  const normalized = normalizeMagnetHash(input);
  return normalized ? normalized.hash : null;
}
