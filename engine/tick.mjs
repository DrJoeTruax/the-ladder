// The Ladder's engine. GitHub runs this every 30 minutes (see .github/workflows/tick.yml).
// One tick: read NOAA, score any finished windows, maybe re-learn, seal the next
// window's call, save a live snapshot for the website, and stamp the record's
// newest fingerprint into the Bitcoin timeline via OpenTimestamps.
//
// Run by hand: node engine/tick.mjs

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Locker } from '../lib/locker.mjs';
import * as sky from '../docs/lib/sky.js';
import { stamp, inspect } from '../docs/lib/ots.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.LADDER_DATA || join(ROOT, 'docs', 'data');
const locker = new Locker(join(DATA, 'sky-locker.jsonl'));
const STAMPS = join(DATA, 'stamps.json');
const log = (...a) => console.log(new Date().toISOString(), ...a);

const check = locker.verify();
if (!check.ok) { console.error('The Locker failed its check, refusing to add to it:', check.problem); process.exit(1); }
const startHead = locker.head;

const skySeals = () => locker.ofType('seal').filter((e) => e.body.kind === 'sky');
const resultFor = (hash) => locker.ofType('result').find((e) => e.body.seal === hash);
function currentSkyModel() {
  const models = locker.ofType('model').filter((e) => e.body.kind === 'sky-model');
  return models.length ? models[models.length - 1].body : null;
}

if (!currentSkyModel()) locker.append('model', { kind: 'sky-model', id: sky.MODEL_V1.id, plain: sky.MODEL_V1.plain, w: sky.MODEL_V1.w });

let wind = null, kp = null, error = null;
try {
  [wind, kp] = await Promise.all([sky.readSolarWind(), sky.readKp()]);
} catch (err) {
  error = String(err.message || err);
  log('NOAA read failed:', error);
}

if (kp) {
  // 1. Score every sealed window NOAA has now measured.
  for (const s of skySeals()) {
    if (resultFor(s.hash)) continue;
    const t = Date.parse(s.body.block + 'Z');
    if (!kp.observed.has(t)) continue;
    const obs = kp.observed.get(t);
    const err = (x) => (x == null ? null : +Math.abs(x - obs).toFixed(2));
    locker.append('result', {
      kind: 'sky', seal: s.hash, block: s.body.block, observed: obs, source: 'NOAA SWPC planetary K-index (preliminary)',
      errors: { ladder: err(s.body.prediction), persistence: err(s.body.rivals.persistence), noaa: err(s.body.rivals.noaa?.kp) },
    });
    log('scored', s.body.block, 'observed', obs);
  }

  // 2. Re-learn from sealed history (12+ scored, then every 8 more). A new version
  //    is sealed before use and only judged on windows after it.
  const rows = skySeals().map((s) => ({ s, r: resultFor(s.hash) })).filter((x) => x.r)
    .map(({ s, r }) => ({ newellKp: s.body.inputs.newellKp, persistence: s.body.inputs.persistence, observed: r.body.observed }));
  const model = currentSkyModel();
  if (rows.length >= 12 && rows.length - (model.trainedOn ?? 0) >= 8) {
    const w = sky.refit(rows);
    if (w) {
      const version = Number(model.id.split('-v')[1]) + 1;
      locker.append('model', { kind: 'sky-model', id: `ladder-sky-v${version}`, trainedOn: rows.length, w, plain: `Same inputs, weights re-learned from ${rows.length} sealed and scored windows. Judged only on windows after this moment.` });
      log('new model', `v${version}`, JSON.stringify(w));
    }
  }
}

// 3. Seal the next window's call, if it isn't sealed yet. Always before the window starts.
if (wind && kp && kp.lastObserved && wind.hour.count) {
  const now = Date.now();
  const target = sky.nextBlock(now);
  const block = sky.isoBlock(target);
  if (!skySeals().some((s) => s.body.block === block)) {
    const model = currentSkyModel();
    const inputs = {
      newellKp: +wind.hour.newellKp.toFixed(3), persistence: kp.lastObserved.kp, persistenceBlock: sky.isoBlock(kp.lastObserved.t),
      windMinutes: wind.hour.count, windAt: new Date(wind.latest.t).toISOString(),
      speed: Math.round(wind.hour.v), bz: +wind.hour.bz.toFixed(2), density: +wind.hour.n.toFixed(2),
    };
    const e = locker.append('seal', {
      kind: 'sky', block, leadMinutes: Math.round((target - now) / 60000), model: { id: model.id, w: model.w }, inputs,
      prediction: sky.predictWith(model, inputs), rivals: { persistence: inputs.persistence, noaa: kp.noaa.get(target) ?? null },
    });
    log('sealed', block, 'prediction', e.body.prediction);
  }
}

// 4. Live snapshot for the website (the page never needs to call NOAA itself).
const live = {
  at: new Date().toISOString(), error,
  wind: wind ? { ...wind.latest, at: new Date(wind.latest.t).toISOString() } : null,
  hour: wind?.hour ?? null, trail: wind?.trail ?? [],
  lastKp: kp?.lastObserved ? { block: sky.isoBlock(kp.lastObserved.t), kp: kp.lastObserved.kp } : null,
  observedRecent: kp ? [...kp.observed.entries()].sort((a, b) => a[0] - b[0]).slice(-16).map(([t, v]) => ({ block: sky.isoBlock(t), kp: v })) : [],
  upcoming: kp ? [...kp.noaa.entries()].filter(([t]) => t >= sky.blockStart(Date.now())).slice(0, 8).map(([t, v]) => ({ block: sky.isoBlock(t), noaa: v.kp })) : [],
  model: currentSkyModel(),
};
writeFileSync(join(DATA, 'live.json'), JSON.stringify(live));

// 5. Public fingerprint: stamp the newest entry whenever the record grew.
const stamps = existsSync(STAMPS) ? JSON.parse(readFileSync(STAMPS, 'utf8')) : [];
const newest = locker.entries[locker.entries.length - 1];
if (newest && (locker.head !== startHead || !stamps.some((s) => s.hash === newest.hash))) {
  try {
    const proof = await stamp(newest.hash);
    const info = inspect(proof.bytes);
    if (info.digest !== newest.hash || !info.complete) throw new Error('Proof did not check out.');
    mkdirSync(join(DATA, 'ots'), { recursive: true });
    const file = `ots/${String(newest.seq).padStart(6, '0')}-${newest.hash.slice(0, 12)}.ots`;
    writeFileSync(join(DATA, file), proof.bytes);
    stamps.push({ seq: newest.seq, hash: newest.hash, at: new Date().toISOString(), file, calendars: proof.calendars });
    writeFileSync(STAMPS, JSON.stringify(stamps, null, 1));
    log('stamped', newest.seq, newest.hash.slice(0, 12), 'via', proof.calendars.length, 'calendars');
  } catch (err) {
    log('stamp failed (will retry next tick):', String(err.message || err));
  }
}

log(`done: ${locker.entries.length} entries, head ${locker.head.slice(0, 12)}`);
