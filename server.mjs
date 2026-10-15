// The Ladder on Joe's PC: the same website as the public one, plus a private
// personal record (helicopter rounds, your own guesses) kept in data/, which is
// never uploaded. The space-weather engine runs on GitHub, not here.
// Run: node server.mjs   (then open http://127.0.0.1:8777)

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, readdirSync } from 'node:fs';
import { join, extname, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Locker } from './lib/locker.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SITE = join(ROOT, 'docs');
const PORT = Number(process.env.LADDER_PORT || 8777);
const DATA = process.env.LADDER_DATA || join(ROOT, 'data');
const STAMP_DIR = join(DATA, 'personal-ots');
const personal = new Locker(join(DATA, 'personal-locker.jsonl'));
mkdirSync(STAMP_DIR, { recursive: true });

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.jsonl': 'application/x-ndjson', '.ots': 'application/octet-stream' };

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 2e5) throw new Error('too big'); }
  return raw ? JSON.parse(raw) : {};
}

function stamps() {
  const out = {};
  for (const f of readdirSync(STAMP_DIR)) if (f.endsWith('.ots')) out[f.slice(0, -4)] = readFileSync(join(STAMP_DIR, f)).toString('base64');
  return out;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/local/ping') return send(res, 200, { ok: true, who: 'local' });
    if (url.pathname === '/api/personal' && req.method === 'GET') return send(res, 200, { entries: personal.entries, stamps: stamps(), verify: personal.verify() });
    if (url.pathname === '/api/personal/append' && req.method === 'POST') {
      const { entry } = await readBody(req);
      if (!entry || !personal.acceptBuilt(entry)) return send(res, 409, { error: 'That entry does not link to your record. Reload the page and try again.' });
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/personal/stamp' && req.method === 'POST') {
      const { hash, b64 } = await readBody(req);
      if (!/^[0-9a-f]{64}$/.test(hash || '') || !personal.find(hash)) return send(res, 404, { error: 'Unknown entry.' });
      writeFileSync(join(STAMP_DIR, `${hash}.ots`), Buffer.from(String(b64), 'base64'));
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/personal/download') return send(res, 200, existsSync(personal.file) ? readFileSync(personal.file) : '', 'application/x-ndjson');
    // the website itself
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = normalize(join(SITE, rel));
    if (!file.startsWith(SITE) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: 'not found' });
    return send(res, 200, readFileSync(file), TYPES[extname(file)] || 'application/octet-stream');
  } catch (err) {
    return send(res, 500, { error: String(err.message || err) });
  }
});

const check = personal.verify();
if (!check.ok) console.error('WARNING: your personal record failed its check:', check.problem);
server.listen(PORT, '127.0.0.1', () => console.log(`The Ladder (your PC): http://127.0.0.1:${PORT}  · personal record: ${personal.entries.length} entries, ${check.ok ? 'intact' : 'BROKEN'}`));
