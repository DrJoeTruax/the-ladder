// Sky proving ground: predict Earth's geomagnetic activity (the Kp index, 0-9)
// for the next 3-hour window, seal it, then let NOAA's measured value score it.
//
// Inputs are live NOAA SWPC feeds (no key needed):
//   - real-time solar wind measured ~1.5 million km upstream at L1
//   - observed Kp (3-hour blocks) and NOAA's own Kp forecast (our toughest rival)

const SWPC = 'https://services.swpc.noaa.gov';
export const FEEDS = {
  wind: `${SWPC}/json/rtsw/rtsw_wind_1m.json`,
  mag: `${SWPC}/json/rtsw/rtsw_mag_1m.json`,
  kp: `${SWPC}/products/noaa-planetary-k-index.json`,
  forecast: `${SWPC}/products/noaa-planetary-k-index-forecast.json`,
};

export const BLOCK_MS = 3 * 3600 * 1000;
export const blockStart = (ms) => Math.floor(ms / BLOCK_MS) * BLOCK_MS;
export const nextBlock = (ms) => blockStart(ms) + BLOCK_MS;
export const isoBlock = (ms) => new Date(ms).toISOString().slice(0, 19);
const tagMs = (tag) => Date.parse(tag.endsWith('Z') ? tag : tag + 'Z');

async function getJSON(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

// Newell et al. (2008) solar-wind -> Kp relation, from their "universal"
// coupling function dPhi/dt = v^(4/3) Bt^(2/3) sin^(8/3)(theta/2).
export function newellKp(v, n, by, bz) {
  const bt = Math.hypot(by, bz);
  const theta = Math.atan2(by, bz);
  const s = Math.abs(Math.sin(theta / 2));
  const dphi = Math.pow(v, 4 / 3) * Math.pow(bt, 2 / 3) * Math.pow(s, 8 / 3);
  return 0.05 + 2.244e-4 * dphi + 2.844e-6 * Math.sqrt(Math.max(n, 0.1)) * v * v;
}

export async function readSolarWind() {
  const [wind, mag] = await Promise.all([getJSON(FEEDS.wind), getJSON(FEEDS.mag)]);
  const byMinute = new Map();
  for (const r of wind) if (r.active && r.proton_speed) byMinute.set(r.time_tag.slice(0, 16), { v: r.proton_speed, n: r.proton_density ?? 1, source: r.source });
  const minutes = [];
  for (const r of mag) {
    if (!r.active || r.bz_gsm == null || r.by_gsm == null) continue;
    const w = byMinute.get(r.time_tag.slice(0, 16));
    if (!w) continue;
    minutes.push({ t: tagMs(r.time_tag.slice(0, 16)), v: w.v, n: w.n, by: r.by_gsm, bz: r.bz_gsm, bt: r.bt, source: w.source, kp: newellKp(w.v, w.n, r.by_gsm, r.bz_gsm) });
  }
  minutes.sort((a, b) => a.t - b.t);
  if (!minutes.length) throw new Error('No active solar-wind readings right now.');
  const latest = minutes[minutes.length - 1];
  const lastHour = minutes.filter((m) => m.t > latest.t - 3600 * 1000);
  const mean = (k) => lastHour.reduce((s, m) => s + m[k], 0) / lastHour.length;
  return {
    latest,
    hour: { count: lastHour.length, v: mean('v'), n: mean('n'), bz: mean('bz'), newellKp: mean('kp') },
    // a light trail for the chart: one point every 10 minutes over the last day
    trail: minutes.filter((_, i) => i % 10 === 0).map((m) => ({ t: m.t, v: Math.round(m.v), bz: +m.bz.toFixed(2), kp: +m.kp.toFixed(2) })),
  };
}

export async function readKp() {
  const [kp, forecast] = await Promise.all([getJSON(FEEDS.kp), getJSON(FEEDS.forecast)]);
  const observed = new Map();
  for (const r of kp) observed.set(tagMs(r.time_tag), r.Kp);
  const noaa = new Map();
  for (const r of forecast) if (r.observed !== 'observed') noaa.set(tagMs(r.time_tag), { kp: r.kp, kind: r.observed });
  const lastObserved = [...observed.entries()].sort((a, b) => a[0] - b[0]).pop();
  return { observed, noaa, lastObserved: lastObserved ? { t: lastObserved[0], kp: lastObserved[1] } : null };
}

// The Ladder's own predictor. Weights are fixed per version and sealed in the
// Locker before use, so the tool can never quietly re-tune itself after a miss.
export const MODEL_V1 = {
  id: 'ladder-sky-v1',
  plain: 'Physics formula from the last hour of solar wind (60%) blended with the most recent measured Kp (40%).',
  w: { newell: 0.6, persistence: 0.4, bias: 0 },
};

export function predictWith(model, inputs) {
  const raw = model.w.bias + model.w.newell * inputs.newellKp + model.w.persistence * inputs.persistence;
  return Math.min(9, Math.max(0, +raw.toFixed(2)));
}

// Least-squares refit from sealed history: kp_obs ~ a*newell + b*persistence + c.
// Only ever used to create a NEW sealed version; old predictions keep their model.
export function refit(rows) {
  if (rows.length < 12) return null;
  const X = rows.map((r) => [r.newellKp, r.persistence, 1]);
  const y = rows.map((r) => r.observed);
  const XtX = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], Xty = [0, 0, 0];
  for (let i = 0; i < X.length; i++) for (let a = 0; a < 3; a++) {
    Xty[a] += X[i][a] * y[i];
    for (let b = 0; b < 3; b++) XtX[a][b] += X[i][a] * X[i][b];
  }
  for (let a = 0; a < 3; a++) XtX[a][a] += 0.5; // gentle ridge: stay close to sane values with few rows
  const w = solve3(XtX, Xty);
  if (!w) return null;
  return { newell: +w[0].toFixed(3), persistence: +w[1].toFixed(3), bias: +w[2].toFixed(3) };
}

function solve3(A, b) {
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-9) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < 3; r++) if (r !== c) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
    }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}

export function kpWords(kp) {
  if (kp >= 7) return 'strong storm';
  if (kp >= 5) return 'storm';
  if (kp >= 4) return 'unsettled, auroras far north';
  if (kp >= 2) return 'quiet to unsettled';
  return 'quiet';
}
