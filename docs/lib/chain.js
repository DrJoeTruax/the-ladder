// Shared by the website and the engine: the Locker's fingerprint chain.
// Each entry's SHA-256 covers its own content and the previous entry's hash,
// so changing or deleting any old entry breaks every link after it.
// Uses Web Crypto, which both browsers and Node 20+ provide.

export const GENESIS = '0'.repeat(64);

// Stable JSON: keys sorted at every level, so the same content always hashes the same.
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort()
    .filter((k) => value[k] !== undefined)
    .map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

export function fingerprint({ seq, type, at, body, prev }) {
  return sha256Hex(canonical({ seq, type, at, body, prev }));
}

export async function makeEntry(entries, type, body, at = new Date().toISOString()) {
  const entry = { seq: entries.length, type, at, body, prev: entries.length ? entries[entries.length - 1].hash : GENESIS };
  entry.hash = await fingerprint(entry);
  return entry;
}

export async function verifyChain(entries) {
  let prev = GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.seq !== i) return { ok: false, count: i, problem: `Entry ${i} is out of order.` };
    if (e.prev !== prev) return { ok: false, count: i, problem: `Entry ${i} does not link to the entry before it.` };
    if ((await fingerprint(e)) !== e.hash) return { ok: false, count: i, problem: `Entry ${i} was changed after it was sealed.` };
    prev = e.hash;
  }
  return { ok: true, count: entries.length, head: prev };
}

export const parseJsonl = (text) => text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
