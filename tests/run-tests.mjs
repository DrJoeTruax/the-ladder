// Run: node tests/run-tests.mjs   (exit code 0 = all pass). No network needed.
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Locker } from '../lib/locker.mjs';
import * as chain from '../docs/lib/chain.js';
import * as ots from '../docs/lib/ots.js';
import * as sky from '../docs/lib/sky.js';
import * as desk from '../docs/lib/desk.js';
import * as S from '../docs/lib/state.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  · ' + detail : ''}`); };

// ---- Locker (Node) ----
const dir = mkdtempSync(join(tmpdir(), 'ladder-test-'));
const file = join(dir, 'locker.jsonl');
const L = new Locker(file);
L.append('seal', { kind: 'desk', guess: 2.1 });
L.append('result', { kind: 'desk', mean: 2.3 });
L.append('rung', { text: 'hello' });
check('fresh chain verifies', L.verify().ok);
check('reloaded chain verifies', new Locker(file).verify().ok);
check('website and Node compute the same fingerprints', (await chain.verifyChain(L.entries)).ok);
const lines = readFileSync(file, 'utf8').trim().split('\n');
const tampered = JSON.parse(lines[0]); tampered.body.guess = 2.3; // "I said 2.3 all along"
writeFileSync(file, [JSON.stringify(tampered), ...lines.slice(1)].join('\n') + '\n');
const t = new Locker(file).verify();
check('changing an old guess is caught', !t.ok && /changed/.test(t.problem), t.problem);
check('the website catches it too', !(await chain.verifyChain(new Locker(file).entries)).ok);
writeFileSync(file, [lines[0], lines[2]].join('\n') + '\n');
check('deleting an entry is caught', !new Locker(file).verify().ok);

// browser-built entries are accepted by the PC only if they link and hash correctly
const P = new Locker(join(dir, 'personal.jsonl'));
const good = await chain.makeEntry(P.entries, 'seal', { kind: 'sky-guess', block: '2026-10-15T09:00:00', kp: 2 });
check('PC accepts a correct browser-built entry', P.acceptBuilt(good));
const forged = await chain.makeEntry(P.entries, 'seal', { kind: 'sky-guess', block: '2026-10-15T12:00:00', kp: 3 });
forged.body.kp = 1;
check('PC rejects an entry altered after hashing', !P.acceptBuilt(forged));
rmSync(dir, { recursive: true, force: true });

// ---- The real public record ----
const real = new Locker(join(ROOT, 'docs', 'data', 'sky-locker.jsonl'));
check('the public record verifies', real.verify().ok, `${real.entries.length} entries`);

// ---- OpenTimestamps proof files ----
const digest = 'ab'.repeat(32);
const enc = (s) => new TextEncoder().encode(s);
const uri = enc('https://calendar.example');
const fakeCalendar = Uint8Array.from([0xf0, 4, 1, 2, 3, 4, 0x08, 0x00, 0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e, uri.length + 1, uri.length, ...uri]);
const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(fakeCalendar);
const stamped = await ots.stamp(digest, { calendars: ['https://one', 'https://two'] });
globalThis.fetch = realFetch;
const info = ots.inspect(stamped.bytes);
check('proof file has the right digest', info.digest === digest);
check('proof file joins two calendars and reads to the end', info.pending.length === 2 && info.complete, info.pending.join(', '));
check('a non-proof file is rejected', (() => { try { ots.inspect(new Uint8Array(40)); return false; } catch { return true; } })());
check('base64 round-trips', ots.toBase64(ots.fromBase64(ots.toBase64(stamped.bytes))) === ots.toBase64(stamped.bytes));

// ---- Sky ----
check('block math: next window starts on a 3-hour boundary', sky.nextBlock(Date.parse('2026-10-14T07:10:00Z')) === Date.parse('2026-10-14T09:00:00Z'));
check('website block math agrees', S.nextBlock(Date.parse('2026-10-14T07:10:00Z')) === '2026-10-14T09:00:00');
const quiet = sky.newellKp(380, 4, 1, 3);
const storm = sky.newellKp(750, 10, 5, -20);
check('physics: quiet wind gives low Kp', quiet > 0 && quiet < 3, quiet.toFixed(2));
check('physics: storm wind gives high Kp', storm > 5, storm.toFixed(2));
check('physics: southward field drives more than northward', sky.newellKp(500, 5, 0, -8) > sky.newellKp(500, 5, 0, 8));
const synth = Array.from({ length: 30 }, (_, i) => { const n = 1 + (i % 5), p = 1 + ((i * 7) % 4); return { newellKp: n, persistence: p, observed: 0.5 * n + 0.4 * p + 0.2 }; });
const w = sky.refit(synth);
check('refit recovers known weights', Math.abs(w.newell - 0.5) < 0.08 && Math.abs(w.persistence - 0.4) < 0.08, JSON.stringify(w));
check('refit refuses with too little history', sky.refit(synth.slice(0, 5)) === null);

// ---- Scoring from the record ----
const rows = S.skyRows(real.entries);
const board = S.skyScoreboard(rows, []);
check('scoreboard counts match scored windows', board.ladder.n === rows.filter((r) => r.errors).length, `${board.ladder.n} scored`);
const personal = [];
personal.push(await chain.makeEntry(personal, 'seal', { kind: 'sky-guess', block: rows[0].block, kp: 2 }));
const guesses = S.mySkyGuesses(personal, S.observedMap(real.entries, null));
check('your guesses get scored against the public answer', guesses[0].observed === rows[0].observed);

// early + late calls: the latest call sealed BEFORE the window counts; calls after the start never count
const calls = [];
const blk = '2026-10-20T12:00:00';
const mk = async (at, prediction) => calls.push(await chain.makeEntry(calls, 'seal', { kind: 'sky', block: blk, model: { id: 'm' }, prediction, rivals: {}, inputs: {} }, at));
await mk('2026-10-20T07:00:00.000Z', 1.0); // early call
await mk('2026-10-20T10:30:00.000Z', 2.0); // late call
await mk('2026-10-20T12:30:00.000Z', 9.0); // after the window started: must be ignored
const chosen = S.skyRows(calls);
check('one row per window, using the latest call sealed before it', chosen.length === 1 && chosen[0].prediction === 2.0, `picked ${chosen[0]?.prediction}`);

// ---- Desk ----
const prior = desk.calibrate([]);
const std = desk.predict(desk.STANDARD, 2.4, prior);
check('standard helicopter from 2.4 m: prior guess is plausible (1-4 s)', std.seconds > 1 && std.seconds < 4, `${std.seconds} s, range ${std.low}-${std.high}`);
check('heavier clip falls faster', desk.fallTime(desk.STANDARD, 2.4, 2.5, 'large').seconds < desk.fallTime(desk.STANDARD, 2.4, 2.5, 'small').seconds);
const cdBack = desk.impliedCd(desk.STANDARD, 2.4, desk.fallTime(desk.STANDARD, 2.4, 3.1).seconds);
check('inverse physics round-trips', Math.abs(cdBack - 3.1) < 1e-6, cdBack.toFixed(4));
check('faster than free fall is rejected', desk.impliedCd(desk.STANDARD, 2.4, 0.5) === null);
const TRUE_CD = 3.4;
const obs = [];
const errors = [];
let seed = 7; const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
for (let round = 0; round < 6; round++) {
  const cal = desk.calibrate(obs);
  const plan = desk.design(round === 0 ? 'standard' : round % 2 ? 'longest' : 'target', { heightM: 2.4, cal, targetSeconds: 2.6 });
  const truth = desk.fallTime(plan.design, 2.4, TRUE_CD * (1 + (rand() - 0.5) * 0.15)).seconds;
  errors.push(Math.abs(plan.prediction.seconds - truth) / truth * 100);
  obs.push({ design: plan.design, heightM: 2.4, clip: 'small', mean: truth });
}
check('the tool gets closer as it learns', errors[errors.length - 1] < errors[0], errors.map((e) => e.toFixed(1) + '%').join(' → '));
check('uncertainty shrinks with drops', desk.calibrate(obs).sd < prior.sd / 2);
const longest = desk.design('longest', { heightM: 2.4, cal: prior });
check('designer respects its limits', longest.design.L <= 12 && longest.design.W >= 3 && longest.design.L / longest.design.W <= 3.0001, JSON.stringify(longest.design));
check("designer's longest beats the standard", longest.prediction.seconds > std.seconds, `${longest.prediction.seconds} vs ${std.seconds}`);
const target = desk.design('target', { heightM: 2.4, cal: prior, targetSeconds: 2.2 });
check('designer can hit a target time', Math.abs(target.prediction.seconds - 2.2) < 0.08, `${target.prediction.seconds} s`);
check('template is real-size US Letter', desk.templateSVG(longest.design, { heightM: 2.4, clip: 'small' }).includes('width="215.9mm"'));
const sealE = await chain.makeEntry([], 'seal', { kind: 'desk', prediction: std, joeGuess: 2.0 });
const scored = S.scoreRound(sealE, [2.3, 2.4, 2.35]);
check('a round scores both the tool and you', scored.toolErrorPct > 0 && scored.joeErrorPct > 0, `tool ${scored.toolErrorPct}%, you ${scored.joeErrorPct}%`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
