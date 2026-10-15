// OpenTimestamps: anchor a fingerprint into the Bitcoin timeline, for free.
// We send ONLY the 32-byte hash to public calendar servers. They answer at once
// with a "pending" proof; within a few hours the calendars fold it into a Bitcoin
// block. Anyone can then check it with the standard tools (opentimestamps.org).
// Works in browsers (calendars allow cross-site requests) and in Node.

export const CALENDARS = [
  'https://b.pool.opentimestamps.org',
  'https://a.pool.eternitywall.com',
  'https://finney.calendar.eternitywall.com',
];

// "\x00OpenTimestamps\x00\x00Proof\x00" + magic, the standard .ots file header
const MAGIC = [0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00, 0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94];
const OP_SHA256 = 0x08;
const PENDING_TAG = '83dfe30d2ef90c8e';
const BITCOIN_TAG = '0588960d73d71901';

export const hexToBytes = (hex) => new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
const bytesToHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Returns { bytes: Uint8Array (a complete .ots file), calendars: [answered URLs] }.
export async function stamp(hexDigest, { calendars = CALENDARS, timeoutMs = 15000 } = {}) {
  const digest = hexToBytes(hexDigest);
  const answers = await Promise.allSettled(calendars.map(async (url) => {
    const res = await fetch(`${url}/digest`, { method: 'POST', body: digest, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return { url, bytes: new Uint8Array(await res.arrayBuffer()) };
  }));
  const ok = answers.filter((a) => a.status === 'fulfilled' && a.value.bytes.length > 0).map((a) => a.value);
  if (!ok.length) throw new Error('No timestamp server answered.');
  // Each calendar answer is a proof path starting from our digest. Several paths
  // are joined with 0xff "fork" markers, exactly as the OpenTimestamps format expects.
  const parts = [Uint8Array.from(MAGIC), Uint8Array.of(0x01, OP_SHA256), digest];
  ok.forEach((a, i) => { if (i < ok.length - 1) parts.push(Uint8Array.of(0xff)); parts.push(a.bytes); });
  return { bytes: concat(parts), calendars: ok.map((a) => a.url) };
}

// Reads a .ots file well enough to check it: digest, pending calendars, Bitcoin attestations.
export function inspect(bytes) {
  let i = 0;
  const need = (n) => { if (i + n > bytes.length) throw new Error('Proof file ends early.'); };
  const byte = () => { need(1); return bytes[i++]; };
  const take = (n) => { need(n); const s = bytes.slice(i, i + n); i += n; return s; };
  const varuint = () => { let v = 0, shift = 0, b; do { b = byte(); v |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80); return v; };
  const varbytes = () => take(varuint());
  for (const m of MAGIC) if (byte() !== m) throw new Error('Not an OpenTimestamps proof.');
  if (varuint() !== 1) throw new Error('Unknown proof version.');
  if (byte() !== OP_SHA256) throw new Error('Expected a SHA-256 proof.');
  const digest = bytesToHex(take(32));
  const pending = [], bitcoin = [];
  const item = (tag) => {
    if (tag === 0x00) {
      const kind = bytesToHex(take(8));
      const payload = varbytes();
      if (kind === PENDING_TAG) { let j = 0, len = 0, shift = 0, b; do { b = payload[j++]; len |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80); pending.push(new TextDecoder().decode(payload.slice(j, j + len))); }
      else if (kind === BITCOIN_TAG) { let j = 0, h = 0, shift = 0, b; do { b = payload[j++]; h |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80); bitcoin.push(h); }
      return;
    }
    if (tag === 0xf0 || tag === 0xf1) varbytes(); // append / prepend
    else if (![0x08, 0x02, 0x03, 0x67].includes(tag)) throw new Error(`Unknown step 0x${tag.toString(16)} in proof.`);
    timestamp();
  };
  const timestamp = () => {
    let tag = byte();
    while (tag === 0xff) { item(byte()); tag = byte(); }
    item(tag);
  };
  timestamp();
  return { digest, pending, bitcoin, complete: i === bytes.length };
}

export function toBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
export function fromBase64(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
