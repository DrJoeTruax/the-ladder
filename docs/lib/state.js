// Pure functions that turn Locker entries into what the page shows.
// Shared by the website and the engine. No network, no storage.

import * as desk from './desk.js';

const BLOCK_MS = 3 * 3600 * 1000;
export const blockMs = (iso) => Date.parse(iso.endsWith('Z') ? iso : iso + 'Z');
export const isoBlock = (ms) => new Date(ms).toISOString().slice(0, 19);
export const nextBlock = (ms) => isoBlock((Math.floor(ms / BLOCK_MS) + 1) * BLOCK_MS);

const resultsBySeal = (entries) => {
  const m = new Map();
  for (const e of entries) if (e.type === 'result' && e.body.seal) m.set(e.body.seal, e);
  return m;
};

export function currentModel(entries, kind) {
  const models = entries.filter((e) => e.type === 'model' && e.body.kind === kind);
  return models.length ? models[models.length - 1].body : null;
}

// ---------- public sky record ----------
export function skyRows(entries) {
  const results = resultsBySeal(entries);
  return entries.filter((e) => e.type === 'seal' && e.body.kind === 'sky').map((s) => {
    const r = results.get(s.hash);
    return { block: s.body.block, sealedAt: s.at, hash: s.hash, seq: s.seq, model: s.body.model.id, prediction: s.body.prediction, rivals: s.body.rivals, inputs: s.body.inputs, leadMinutes: s.body.leadMinutes, observed: r?.body.observed ?? null, errors: r?.body.errors ?? null };
  });
}

// What actually happened, per 3-hour block: from scored results, plus the latest live snapshot.
export function observedMap(entries, live) {
  const m = new Map();
  for (const o of live?.observedRecent || []) m.set(o.block, o.kp);
  for (const e of entries) if (e.type === 'result' && e.body.kind === 'sky') m.set(e.body.block, e.body.observed);
  return m;
}

const mae = (xs) => (xs.length ? { mae: +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2), n: xs.length } : { mae: null, n: 0 });

export function skyScoreboard(rows, myGuesses) {
  const scored = rows.filter((r) => r.errors);
  const col = (k) => mae(scored.map((r) => r.errors[k]).filter((x) => x != null));
  return { ladder: col('ladder'), persistence: col('persistence'), noaa: col('noaa'), you: mae(myGuesses.filter((g) => g.observed != null).map((g) => Math.abs(g.kp - g.observed))) };
}

// ---------- personal record (your own guesses and helicopter rounds) ----------
export function mySkyGuesses(personal, observed) {
  return personal.filter((e) => e.type === 'seal' && e.body.kind === 'sky-guess')
    .map((g) => ({ block: g.body.block, kp: g.body.kp, sealedAt: g.at, hash: g.hash, observed: observed.get(g.body.block) ?? null }));
}

export function deskRounds(personal) {
  const results = resultsBySeal(personal);
  return personal.filter((e) => e.type === 'seal' && e.body.kind === 'desk').map((s, i) => {
    const r = results.get(s.hash);
    return { round: i + 1, hash: s.hash, sealedAt: s.at, goal: s.body.goal, design: s.body.design, heightM: s.body.heightM, clip: s.body.clip, prediction: s.body.prediction, joeGuess: s.body.joeGuess, result: r ? r.body : null };
  });
}

export function deskObservations(rounds) {
  return rounds.filter((r) => r.result).map((r) => ({ design: r.design, heightM: r.heightM, clip: r.clip, mean: r.result.mean }));
}

export function deskCalibration(rounds) {
  const c = desk.calibrate(deskObservations(rounds));
  return { cd: +c.cd.toFixed(3), sd: +c.sd.toFixed(3), drops: c.drops, raw: c };
}

// ---------- the Ladder Log ----------
export function rungs(rounds, board) {
  const out = [];
  const scored = rounds.filter((r) => r.result);
  if (scored.length) {
    const first = scored[0], last = scored[scored.length - 1], one = scored.length === 1;
    out.push({
      kind: 'desk', n: scored.length,
      simple: one ? `Paper helicopter: the helper's first guess was off by ${first.result.toolErrorPct}%. Let's see if it gets better!` : `Paper helicopter: the helper's first guess was off by ${first.result.toolErrorPct}%. Its newest guess was off by ${last.result.toolErrorPct}%.`,
      text: one ? `Paper helicopter: the tool's first sealed guess was off by ${first.result.toolErrorPct}%. Every new round tests whether it learned.` : `Paper helicopter: the tool's first sealed guess was off by ${first.result.toolErrorPct}%; its latest was off by ${last.result.toolErrorPct}%.`,
      expert: `Desk model |err|: round 1 ${first.result.toolErrorPct}%${one ? '' : `, round ${scored.length} ${last.result.toolErrorPct}%`}; interval coverage ${scored.filter((r) => r.result.insideRange).length}/${scored.length}.`,
    });
    const withYou = scored.filter((r) => r.result.joeErrorPct != null);
    if (withYou.length) {
      const avg = (k) => (withYou.reduce((a, r) => a + r.result[k], 0) / withYou.length).toFixed(1);
      out.push({
        kind: 'desk', n: withYou.length,
        simple: `Your guesses were off by ${avg('joeErrorPct')}% on average. The helper's were off by ${avg('toolErrorPct')}%.`,
        text: `Your own guesses averaged ${avg('joeErrorPct')}% off. The tool averaged ${avg('toolErrorPct')}% off on the same drops.`,
        expert: `Paired comparison, ${withYou.length} round${withYou.length === 1 ? '' : 's'}: human MAPE ${avg('joeErrorPct')}%, model MAPE ${avg('toolErrorPct')}%.`,
      });
    }
  }
  if (board.ladder.n) out.push({
    kind: 'sky', n: board.ladder.n,
    simple: `Space weather: after ${board.ladder.n} real check${board.ladder.n === 1 ? '' : 's'}, our helper was off by ${board.ladder.mae} on average. NOAA's scientists were off by ${board.noaa.mae ?? '?'}. "Same as last time" was off by ${board.persistence.mae}.`,
    text: `Space weather: the tool was off by ${board.ladder.mae} Kp on average over ${board.ladder.n} sealed windows. Just repeating the last value was off by ${board.persistence.mae}; NOAA's forecast by ${board.noaa.mae ?? 'n/a'}.`,
    expert: `Kp MAE over n = ${board.ladder.n}: Ladder ${board.ladder.mae}, SWPC ${board.noaa.mae ?? 'n/a'}, persistence ${board.persistence.mae}. Sample too small for significance below ~50 blocks.`,
  });
  if (board.you.n) out.push({
    kind: 'sky', n: board.you.n,
    simple: `Your own space guesses were off by ${board.you.mae} on average.`,
    text: `Your sealed Kp guesses averaged ${board.you.mae} off over ${board.you.n} window${board.you.n === 1 ? '' : 's'}.`,
    expert: `Human Kp MAE ${board.you.mae} (n = ${board.you.n}).`,
  });
  return out;
}

// ---------- scoring a helicopter round ----------
export function scoreRound(seal, times, note) {
  const s = desk.score(seal.body.prediction, times);
  const joeErrorPct = seal.body.joeGuess ? +((Math.abs(seal.body.joeGuess - s.mean) / s.mean) * 100).toFixed(1) : null;
  return { kind: 'desk', seal: seal.hash, times: s.times, mean: s.mean, toolErrorPct: s.errorPct, insideRange: s.inside, joeErrorPct, note: note ? String(note).slice(0, 300) : undefined };
}
