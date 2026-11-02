const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Short random id, prefixed by kind for readability in JSON and MCP output. */
export function newId(prefix = "id"): string {
  let s = "";
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${s}`;
}
