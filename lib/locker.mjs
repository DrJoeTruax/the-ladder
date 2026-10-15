// Node-side Locker: the same chain as docs/lib/chain.js, kept in a .jsonl file.
// Uses Node's synchronous SHA-256 with the shared canonical form, so its hashes
// are identical to the ones the website computes.

import { createHash } from 'node:crypto';
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonical, GENESIS } from '../docs/lib/chain.js';

export { canonical, GENESIS };

export function fingerprint({ seq, type, at, body, prev }) {
  return createHash('sha256').update(canonical({ seq, type, at, body, prev })).digest('hex');
}

export class Locker {
  constructor(file) {
    this.file = file;
    this.entries = [];
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) if (line.trim()) this.entries.push(JSON.parse(line));
    } else {
      mkdirSync(dirname(file), { recursive: true });
    }
  }

  get head() {
    return this.entries.length ? this.entries[this.entries.length - 1].hash : GENESIS;
  }

  append(type, body, at = new Date().toISOString()) {
    const entry = { seq: this.entries.length, type, at, body, prev: this.head };
    entry.hash = fingerprint(entry);
    appendFileSync(this.file, JSON.stringify(entry) + '\n');
    this.entries.push(entry);
    return entry;
  }

  // Accept an entry built elsewhere (the browser), only if it links and hashes correctly.
  acceptBuilt(entry) {
    if (entry.seq !== this.entries.length || entry.prev !== this.head || fingerprint(entry) !== entry.hash) return false;
    const clean = { seq: entry.seq, type: entry.type, at: entry.at, body: entry.body, prev: entry.prev, hash: entry.hash };
    appendFileSync(this.file, JSON.stringify(clean) + '\n');
    this.entries.push(clean);
    return true;
  }

  find(hash) {
    return this.entries.find((e) => e.hash === hash);
  }

  ofType(type) {
    return this.entries.filter((e) => e.type === type);
  }

  verify() {
    let prev = GENESIS;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (e.seq !== i) return { ok: false, count: i, problem: `Entry ${i} is out of order.` };
      if (e.prev !== prev) return { ok: false, count: i, problem: `Entry ${i} does not link to the entry before it.` };
      if (fingerprint(e) !== e.hash) return { ok: false, count: i, problem: `Entry ${i} was changed after it was sealed.` };
      prev = e.hash;
    }
    return { ok: true, count: this.entries.length, head: prev };
  }
}
