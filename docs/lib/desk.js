// Desk proving ground: the paper helicopter.
// The Designer picks a shape, the Predictor seals how long it will take to fall,
// Joe drops it and times it, and the Checker scores the guess. Every scored drop
// teaches the model (it learns one number, the rotor's drag coefficient), so the
// next guess should be closer. All lengths in cm unless noted.

const G = 9.81;
const RHO = 1.2; // air density, kg/m^3, room temperature
export const PAPER_G_PER_CM2 = 0.0075; // ordinary 75 g/m^2 (20 lb) copy paper
export const CLIPS = { small: { grams: 0.45, plain: 'a small paper clip' }, large: { grams: 1.4, plain: 'a large paper clip' } };

// Prior belief about the rotor's drag coefficient (based on the blade area).
// Wide on purpose: before any drops, the tool should admit it is unsure.
export const PRIOR = { mean: Math.log(2.5), sd: 0.45 };
export const MODEL_SD = 0.22; // how far real helicopters stray from this simple model, in log-Cd

export const LIMITS = { L: [5, 12], W: [3, 6], Lb: [5, 10], aspect: [1.5, 3.0] };
export const STANDARD = { L: 8, W: 4, Lb: 8 };

export function massGrams(d, clip = 'small') {
  return PAPER_G_PER_CM2 * 2 * d.W * (d.L + d.Lb) + CLIPS[clip].grams;
}

export function fallTime(d, heightM, cd, clip = 'small') {
  const m = massGrams(d, clip) / 1000;
  const A = (2 * d.L * d.W) / 1e4;
  const v = Math.sqrt((2 * m * G) / (RHO * cd * A));
  return { seconds: heightM / v + v / (2 * G), speed: v };
}

// What Cd would explain an observed mean fall time? (inverse of fallTime)
export function impliedCd(d, heightM, seconds, clip = 'small') {
  const disc = G * G * seconds * seconds - 2 * G * heightM;
  if (disc <= 0) return null; // faster than free fall: a timing slip, ignore it
  const v = G * seconds - Math.sqrt(disc);
  const m = massGrams(d, clip) / 1000;
  const A = (2 * d.L * d.W) / 1e4;
  return (2 * m * G) / (RHO * A * v * v);
}

// Normal-normal update on log(Cd) from every scored drop so far.
export function calibrate(observations) {
  let precision = 1 / PRIOR.sd ** 2;
  let weighted = PRIOR.mean * precision;
  for (const o of observations) {
    const cd = impliedCd(o.design, o.heightM, o.mean, o.clip);
    if (!cd) continue;
    const p = 1 / MODEL_SD ** 2;
    precision += p;
    weighted += Math.log(cd) * p;
  }
  const mean = weighted / precision;
  return { lnCd: mean, sd: Math.sqrt(1 / precision), cd: Math.exp(mean), drops: observations.length };
}

export function predict(d, heightM, cal, clip = 'small') {
  const center = fallTime(d, heightM, cal.cd, clip).seconds;
  // fall time scales roughly with sqrt(Cd), so half the log-Cd spread carries over
  const sdLnT = Math.sqrt((0.5 * cal.sd) ** 2 + (0.5 * MODEL_SD) ** 2 + 0.04 ** 2);
  const z80 = 1.2816;
  return {
    seconds: +center.toFixed(2),
    low: +(center * Math.exp(-z80 * sdLnT)).toFixed(2),
    high: +(center * Math.exp(z80 * sdLnT)).toFixed(2),
    sdLnT: +sdLnT.toFixed(3),
  };
}

function* candidates() {
  for (let L = LIMITS.L[0]; L <= LIMITS.L[1]; L += 0.5)
    for (let W = LIMITS.W[0]; W <= LIMITS.W[1]; W += 0.5)
      for (let Lb = LIMITS.Lb[0]; Lb <= LIMITS.Lb[1]; Lb += 0.5) {
        const aspect = L / W;
        if (aspect < LIMITS.aspect[0] || aspect > LIMITS.aspect[1]) continue;
        if (Lb < 0.6 * L) continue; // long rotors on a stubby body tumble
        yield { L, W, Lb };
      }
}

const distance = (a, b) => Math.hypot(a.L - b.L, a.W - b.W, a.Lb - b.Lb);

// goal: 'standard' | 'longest' | 'target'
export function design(goal, { heightM, cal, clip = 'small', targetSeconds }) {
  let best = null;
  let searched = 0;
  if (goal === 'standard') {
    best = { ...STANDARD };
    searched = 1;
  } else {
    let bestScore = Infinity;
    for (const d of candidates()) {
      searched++;
      const t = fallTime(d, heightM, cal.cd, clip).seconds;
      const score = goal === 'longest' ? -t : Math.abs(t - targetSeconds) + 0.01 * distance(d, STANDARD);
      if (score < bestScore) { bestScore = score; best = d; }
    }
  }
  const prediction = predict(best, heightM, cal, clip);
  const why = goal === 'standard'
    ? 'The classic shape. It goes first so the tool can learn how your paper and your room really behave.'
    : goal === 'longest'
      ? `Out of ${searched} shapes that should fly steadily, this one should stay up longest: big blades catch more air for the paper they cost.`
      : `Out of ${searched} steady shapes, this one should come closest to ${targetSeconds} s.`;
  return { goal, design: best, clip, heightM, massGrams: +massGrams(best, clip).toFixed(2), prediction, why, searched, calibration: { cd: +cal.cd.toFixed(3), sd: +cal.sd.toFixed(3), drops: cal.drops } };
}

export function score(prediction, times) {
  const clean = times.map(Number).filter((t) => t > 0 && t < 30);
  const mean = clean.reduce((s, t) => s + t, 0) / clean.length;
  const errorPct = (Math.abs(prediction.seconds - mean) / mean) * 100;
  return { times: clean, mean: +mean.toFixed(3), errorPct: +errorPct.toFixed(1), inside: mean >= prediction.low && mean <= prediction.high };
}

// Steps column to the right of the cut-out, wrapped to fit whatever width is left.
function wrapSteps(steps, x, y) {
  const maxChars = Math.max(22, Math.floor((215.9 - x - 8) / 1.75));
  const out = [];
  let line = y;
  steps.forEach((s, i) => {
    const words = `${i + 1}. ${s}`.split(' ');
    let cur = '';
    for (const w of words) {
      if (cur && (cur + ' ' + w).length > maxChars) { out.push(`<text x="${x}" y="${line}" font-size="3.3" font-family="Arial, sans-serif" fill="#111">${cur}</text>`); line += 4.6; cur = w; }
      else cur = cur ? cur + ' ' + w : w;
    }
    out.push(`<text x="${x}" y="${line}" font-size="3.3" font-family="Arial, sans-serif" fill="#111">${cur}</text>`);
    line += 7.5;
  });
  return out.join('\n');
}

// Printable 1:1 template on US Letter. Everything in millimetres.
export function templateSVG(d, meta = {}) {
  const mm = (cm) => cm * 10;
  const W = mm(d.W), L = mm(d.L), Lb = mm(d.Lb);
  const x0 = 14, y0 = 34;
  const right = x0 + 2 * W, bottom = y0 + L + Lb;
  const cut = 'stroke="#c0262d" stroke-width="0.6"';
  const fold = 'stroke="#1d4ed8" stroke-width="0.5" stroke-dasharray="3 2"';
  const label = (x, y, text, size = 3.2, anchor = 'middle', fill = '#111') => `<text x="${x}" y="${y}" font-size="${size}" text-anchor="${anchor}" fill="${fill}" font-family="Arial, sans-serif">${text}</text>`;
  const steps = [
    'Cut along the solid red lines only.',
    'Fold blade A toward you and blade B away from you along the top dashed line.',
    'Fold both side flaps in along the dashed lines, then fold the bottom up once.',
    `Clip ${meta.clip === 'large' ? 'a large' : 'a small'} paper clip on the folded bottom.`,
    `Drop it blades-up from ${meta.heightM ?? '?'} m. Time from release to floor. Do it 3 times.`,
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="215.9mm" height="279.4mm" viewBox="0 0 215.9 279.4">
<rect width="215.9" height="279.4" fill="#fff"/>
${label(107.95, 12, 'The Ladder · Paper helicopter', 5.2)}
${label(107.95, 19, `Rotor ${d.L} cm × ${d.W} cm · Body ${d.Lb} cm${meta.seal ? ' · Seal ' + meta.seal.slice(0, 10) : ''}`, 3.4)}
${label(107.95, 25, 'Print at 100% (Actual size). The bar at the bottom must measure exactly 5 cm.', 2.8, 'middle', '#555')}
<rect x="${x0}" y="${y0}" width="${2 * W}" height="${L + Lb}" fill="#fbfbf7" stroke="#111" stroke-width="0.4"/>
<line x1="${x0 + W}" y1="${y0}" x2="${x0 + W}" y2="${y0 + L}" ${cut}/>
<line x1="${x0}" y1="${y0 + L}" x2="${x0 + W / 2}" y2="${y0 + L}" ${cut}/>
<line x1="${right}" y1="${y0 + L}" x2="${right - W / 2}" y2="${y0 + L}" ${cut}/>
<line x1="${x0}" y1="${y0 + L}" x2="${right}" y2="${y0 + L}" ${fold}/>
<line x1="${x0 + W / 2}" y1="${y0 + L}" x2="${x0 + W / 2}" y2="${bottom}" ${fold}/>
<line x1="${right - W / 2}" y1="${y0 + L}" x2="${right - W / 2}" y2="${bottom}" ${fold}/>
<line x1="${x0 + W / 2}" y1="${bottom - 15}" x2="${right - W / 2}" y2="${bottom - 15}" ${fold}/>
${label(x0 + W / 2, y0 + L / 2, 'A', 7, 'middle', '#999')}
${label(x0 + 1.5 * W, y0 + L / 2, 'B', 7, 'middle', '#999')}
${label(x0 + W / 2, y0 + L / 2 + 6, 'fold toward you', 2.6, 'middle', '#999')}
${label(x0 + 1.5 * W, y0 + L / 2 + 6, 'fold away', 2.6, 'middle', '#999')}
${label(x0 + W, bottom - 5, 'clip here', 2.6, 'middle', '#999')}
${wrapSteps(steps, right + 10, y0 + 4)}
<line x1="20" y1="268" x2="70" y2="268" stroke="#111" stroke-width="0.8"/>
<line x1="20" y1="265" x2="20" y2="271" stroke="#111" stroke-width="0.5"/>
<line x1="70" y1="265" x2="70" y2="271" stroke="#111" stroke-width="0.5"/>
${label(45, 263, '5 cm check bar', 2.8)}
${label(20, 276, `<tspan fill="#c0262d">— cut</tspan>   <tspan fill="#1d4ed8">- - fold</tspan>`, 3, 'start')}
</svg>`;
}
