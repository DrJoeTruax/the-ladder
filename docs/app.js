// The Ladder website. Works two ways:
//  - Public (GitHub Pages): reads the public record; your own guesses stay in your browser.
//  - On Joe's PC (node server.mjs): same page; your own record is saved privately in data/.
// Every visible sentence comes in three reading levels: 1 Easy (default), 2 Standard, 3 Expert.

import * as desk from './lib/desk.js';
import { parseJsonl, verifyChain, makeEntry } from './lib/chain.js';
import { stamp, toBase64, fromBase64 } from './lib/ots.js';
import * as S from './lib/state.js';

const PUBLIC_SITE = 'https://drjoetruax.github.io/the-ladder/';
const REPO = 'https://github.com/DrJoeTruax/the-ladder';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fx = (n, d = 2) => (n == null || Number.isNaN(n) ? '—' : Number(n).toFixed(d));
let STATE = null;
let PLAN = null;

// ---------- reading levels ----------
const L = (a, b = a, c = b) => `<span class="lv-1">${a}</span><span class="lv-2">${b}</span><span class="lv-3">${c}</span>`;
const level = () => document.documentElement.dataset.level || '1';
const P = (a, b = a, c = b) => ({ 1: a, 2: b, 3: c })[level()];

function setLevel(n) {
  document.documentElement.dataset.level = n;
  document.querySelectorAll('[data-set-level]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.setLevel === n)));
  try { localStorage.setItem('ladder-level', n); } catch {}
  if (STATE) render(true); // menus and placeholders can't hold three versions, so redraw them
}
document.querySelectorAll('[data-set-level]').forEach((b) => { b.onclick = () => setLevel(b.dataset.setLevel); });
let savedLevel = null;
try { savedLevel = localStorage.getItem('ladder-level'); } catch {}
setLevel(['1', '2', '3'].includes(savedLevel) ? savedLevel : '1');

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 5200);
}

// ---------- your own record: on Joe's PC (private file) or in this browser ----------
const store = {
  mode: 'browser', entries: [], stamps: {}, durable: true,
  async init() {
    if (!location.hostname.endsWith('github.io')) try {
      const r = await fetch('/api/local/ping', { cache: 'no-store' });
      if (r.ok && (await r.json()).who === 'local') {
        this.mode = 'local';
        const d = await (await fetch('/api/personal', { cache: 'no-store' })).json();
        this.entries = d.entries; this.stamps = d.stamps;
        return;
      }
    } catch {}
    try {
      this.entries = JSON.parse(localStorage.getItem('ladder-personal') || '[]');
      this.stamps = JSON.parse(localStorage.getItem('ladder-personal-stamps') || '{}');
      localStorage.setItem('ladder-probe', '1');
    } catch { this.durable = false; this.entries = []; this.stamps = {}; }
  },
  saveBrowser() {
    try { localStorage.setItem('ladder-personal', JSON.stringify(this.entries)); localStorage.setItem('ladder-personal-stamps', JSON.stringify(this.stamps)); } catch { this.durable = false; }
  },
  async append(type, body) {
    const e = await makeEntry(this.entries, type, body);
    if (this.mode === 'local') {
      const r = await fetch('/api/personal/append', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entry: e }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not save.');
      this.entries.push(e);
    } else {
      this.entries.push(e);
      this.saveBrowser();
    }
    this.stampLater(e);
    return e;
  },
  // Publicly time-stamp the guess's fingerprint (only the hash leaves this device).
  async stampLater(e) {
    try {
      const { bytes } = await stamp(e.hash);
      const b64 = toBase64(bytes);
      this.stamps[e.hash] = b64;
      if (this.mode === 'local') await fetch('/api/personal/stamp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hash: e.hash, b64 }) });
      else this.saveBrowser();
      if (STATE) render();
    } catch { /* offline: the guess is still sealed in your record, just not publicly stamped */ }
  },
  download() {
    const lines = this.entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    const blob = new Blob([JSON.stringify({ format: 'the-ladder-personal-record', entries: this.entries, stamps: this.stamps }, null, 1)], { type: 'application/json' });
    if (this.mode === 'local') return void window.open('/api/personal/download');
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'my-ladder-record.json' });
    a.click();
    return lines;
  },
};

// ---------- the public record ----------
async function getPublic(path) {
  const bust = `?t=${Math.floor(Date.now() / 60000)}`;
  const bases = location.hostname.endsWith('github.io') ? ['./'] : [PUBLIC_SITE, './'];
  let lastErr;
  for (const base of bases) {
    try {
      const r = await fetch(base + path + bust, { cache: 'no-store' });
      if (r.ok) return { text: await r.text(), from: base };
      lastErr = new Error(`${path}: ${r.status}`);
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function loadPublic() {
  const [lockerRes, liveRes, stampsRes] = await Promise.all([getPublic('data/sky-locker.jsonl'), getPublic('data/live.json'), getPublic('data/stamps.json').catch(() => ({ text: '[]' }))]);
  const entries = parseJsonl(lockerRes.text);
  return { entries, live: JSON.parse(liveRes.text), stamps: JSON.parse(stampsRes.text), from: lockerRes.from, verify: await verifyChain(entries) };
}

async function load() {
  let pub;
  try {
    pub = await loadPublic();
  } catch (e) {
    $('#chips').innerHTML = `<span class="chip bad">${L("Can't load the public record right now. Check your internet and try again.", "Can't load the public record")}: <b>${esc(e.message)}</b></span>`;
    return;
  }
  const personalVerify = await verifyChain(store.entries);
  const observed = S.observedMap(pub.entries, pub.live);
  const rows = S.skyRows(pub.entries);
  const myGuesses = S.mySkyGuesses(store.entries, observed);
  const board = S.skyScoreboard(rows, myGuesses);
  const rounds = S.deskRounds(store.entries);
  STATE = {
    pub, rows, myGuesses, board, rounds, personalVerify,
    model: S.currentModel(pub.entries, 'sky-model') || pub.live.model,
    nextBlock: S.nextBlock(Date.now()),
    calibration: S.deskCalibration(rounds),
    open: rounds.find((r) => !r.result) ?? null,
    rungs: S.rungs(rounds, board),
  };
  render();
}

// ---------- time words ----------
const blockMs = S.blockMs;
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
function windowWords(iso) {
  const a = new Date(blockMs(iso)), b = new Date(blockMs(iso) + 3 * 3600e3);
  return `${dayFmt.format(a)} ${timeFmt.format(a)}–${timeFmt.format(b)}`;
}
function ago(iso) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}
const short = (h) => (h ? h.slice(0, 12) : '');

function kpWords(kp) {
  if (kp >= 7) return L('a big space storm!', 'strong storm', 'strong storm (G3+)');
  if (kp >= 5) return L('a space storm, with northern lights', 'geomagnetic storm', 'geomagnetic storm (G1+)');
  if (kp >= 4) return L('a bit stirred up', 'unsettled, auroras far north', 'active');
  if (kp >= 2) return L('pretty calm', 'quiet to unsettled', 'quiet to unsettled');
  return L('very calm', 'quiet', 'quiet');
}
const stampedMark = (hash) => (store.stamps[hash] ? ` <span class="good" title="Publicly time-stamped">${L('· public time-stamp ✓', '· time-stamped ✓', '· OTS ✓')}</span>` : '');

// ---------- hero chips ----------
function renderChips() {
  const { pub } = STATE;
  const v = pub.verify;
  const dot = `<span class="dot" style="${v.ok ? '' : 'background:var(--bad);box-shadow:0 0 10px var(--bad)'}"></span>`;
  const lastStamp = pub.stamps[pub.stamps.length - 1];
  const fresh = (Date.now() - Date.parse(pub.live.at)) / 60000;
  $('#chips').innerHTML = `
    <span class="chip ${v.ok ? 'ok' : 'bad'}">${dot}${L(v.ok ? 'Public record: <b>nothing changed</b>' : 'Public record: <b>SOMETHING CHANGED</b>', `Public Locker <b>${v.ok ? 'intact' : 'BROKEN'}</b> · ${v.count} entries`, `Public chain <b>${v.ok ? 'verified' : 'BROKEN'}</b> · ${v.count} entries`)}</span>
    ${lastStamp ? `<span class="chip">${L('Stamped into Bitcoin\'s timeline', 'Fingerprint public', 'OTS-anchored')} <b>${ago(lastStamp.at)}</b></span>` : ''}
    <span class="chip">${L('Space data updated', 'Updated', 'live.json')} <b>${ago(pub.live.at)}</b>${fresh > 90 ? ` <span class="bad">${L('(late)', '(late)', '(stale)')}</span>` : ''}</span>
    <span class="chip">${L('Next space guess', 'Next sky window', 'Next Kp block')} <b>${windowWords(STATE.nextBlock)}</b></span>
    ${pub.live.error ? `<span class="chip bad">${L('Space data had a problem', 'NOAA feed', 'SWPC feed error')}: <b>${esc(pub.live.error)}</b></span>` : ''}`;
}

// ---------- sky ----------
function renderSkyLive() {
  const lv = STATE.pub.live;
  if (!lv.wind || !lv.lastKp) { $('#sky-live').innerHTML = `<div class="stat"><div class="k">${L('Live space data', 'Live data')}</div><div class="v">${L('not available', 'unavailable')}</div><div class="s">${esc(lv.error || '')}</div></div>`; return; }
  const w = lv.wind;
  const minutes = Math.round(1.5e6 / w.v / 60);
  const bzEasy = w.bz < -5 ? 'Pointing strongly south. That opens the door, so lots of energy gets in.' : w.bz < 0 ? 'Pointing south. That lets some energy in.' : 'Pointing north. That mostly keeps the energy out.';
  const bzStd = w.bz < -5 ? 'strongly south: the door to Earth is open' : w.bz < 0 ? 'pointing south: lets energy in' : 'pointing north: mostly shut out';
  const speedEasy = w.v > 600 ? 'Very fast!' : w.v > 450 ? 'Pretty fast.' : 'Gentle.';
  const speedStd = w.v > 600 ? 'fast stream' : w.v > 450 ? 'brisk' : 'calm';
  const mph = Math.round(w.v * 2237).toLocaleString();
  $('#sky-live').innerHTML = `
    <div class="stat"><div class="k">${L("How fast the Sun's wind is blowing", `Solar wind speed · ${esc(w.source)}`, `Proton bulk speed · ${esc(w.source)} (L1)`)}</div>
      <div class="v">${L(`${mph} <small>mph</small>`, `${Math.round(w.v)} <small>km/s</small>`, `${fx(w.v, 1)} <small>km/s</small>`)}</div>
      <div class="s">${L(`${speedEasy} It reaches Earth about ${minutes} minutes after the spacecraft feels it.`, `${speedStd}, about ${minutes} min from the spacecraft to Earth`, `n = ${fx(w.n, 2)} cm⁻³ · L1→Earth transit ≈ ${minutes} min · as of ${esc(w.at)}`)}</div></div>
    <div class="stat"><div class="k">${L('Which way its magnetism points', 'Magnetic field direction (Bz)', 'IMF Bz (GSM)')}</div>
      <div class="v">${L(w.bz < 0 ? 'South' : 'North', `${fx(w.bz, 1)} <small>nT</small>`, `${fx(w.bz, 2)} <small>nT</small>`)}</div>
      <div class="s">${L(bzEasy, bzStd, `By ${fx(w.by, 2)} nT · |B| ${fx(w.bt, 2)} nT`)}</div></div>
    <div class="stat"><div class="k">${L(`Earth's storm level, last measured (${windowWords(lv.lastKp.block)})`, `Last measured Kp · ${windowWords(lv.lastKp.block)}`, `Last planetary Kp (preliminary) · ${windowWords(lv.lastKp.block)}`)}</div>
      <div class="v">${fx(lv.lastKp.kp, 2)} ${L('<small>out of 9</small>', '', '')}</div>
      <div class="s">${kpWords(lv.lastKp.kp)}</div></div>`;
}

function renderSkySeal() {
  const { rows, myGuesses, nextBlock } = STATE;
  const row = rows.find((r) => r.block === nextBlock);
  const guess = myGuesses.find((g) => g.block === nextBlock);
  const joeBox = guess
    ? `<div class="note" style="margin-top:14px">${L('Your locked-in guess', 'Your sealed guess for this window', 'Your sealed forecast')}: <b style="color:var(--violet)">${fx(guess.kp, 2)}</b> · ${ago(guess.sealedAt)} · <span class="hash">${short(guess.hash)}</span>${stampedMark(guess.hash)}</div>`
    : `<div style="margin-top:14px"><label for="joe-kp">${L('Want to play? Guess a storm level from 0 to 9. Once you press the button, your guess is locked.', "Your guess for this window (0–9). It's sealed the moment you press the button.", 'Your Kp forecast for this block (0–9), sealed on submit.')}</label>
        <div class="row"><input id="joe-kp" type="number" min="0" max="9" step="0.33" placeholder="e.g. 2.33"><button id="joe-kp-seal" style="flex:0 0 auto">${L('Lock in my guess', 'Seal my guess', 'Seal forecast')}</button></div></div>`;
  if (!row) {
    $('#sky-seal').innerHTML = `<div class="wax">SEAL</div><h3>${L('Next guess', 'Next call', 'Next sealed forecast')}</h3>
      <p class="muted">${L(`Our helper locks in its guess for <b>${windowWords(nextBlock)}</b> soon. It checks every half hour.`, `The engine seals its call for <b>${windowWords(nextBlock)}</b> on its next run (every 30 minutes, on GitHub).`, `Seal for block ${esc(nextBlock)}Z pending on the next scheduled run.`)}</p>${joeBox}`;
  } else {
    const noaa = row.rivals.noaa;
    const inp = row.inputs;
    $('#sky-seal').innerHTML = `<div class="wax">${L('LOCKED', 'SEALED', 'SEALED')}</div>
      <h3>${L('Our helper guessed', 'Sealed call', 'Sealed forecast')} · ${windowWords(row.block)}</h3>
      <div class="big">${fx(row.prediction, 2)} <small>${L('out of 9', 'Kp', 'Kp')} · ${kpWords(row.prediction)}</small></div>
      <p class="muted" style="margin:10px 0 0">${L(
        `Other guesses, locked in at the same moment: <b style="color:var(--blue)">NOAA's scientists ${noaa ? fx(noaa.kp, 2) : '—'}</b> · <b style="color:var(--blue)">"same as last time" ${fx(row.rivals.persistence, 2)}</b>`,
        `Rivals, sealed at the same moment: <b style="color:var(--blue)">NOAA ${noaa ? fx(noaa.kp, 2) : '—'}</b> · <b style="color:var(--blue)">repeat-last ${fx(row.rivals.persistence, 2)}</b>`,
        `Baselines: <b style="color:var(--blue)">SWPC ${noaa ? `${fx(noaa.kp, 2)} (${esc(noaa.kind)})` : 'n/a'}</b> · <b style="color:var(--blue)">persistence ${fx(row.rivals.persistence, 2)} (${esc(inp.persistenceBlock)}Z)</b>`)}</p>
      <p class="faint" style="margin:6px 0 0;font-size:13px">${L(
        `Locked in ${ago(row.sealedAt)}.`,
        `From ${inp.windMinutes} min of solar wind (${inp.speed} km/s, Bz ${inp.bz} nT) · model ${esc(row.model)} · sealed ${ago(row.sealedAt)}`,
        `Inputs: ${inp.windMinutes}×1-min samples to ${esc(inp.windAt)}; ⟨Kp_Newell⟩ ${fx(inp.newellKp, 3)}; ⟨v⟩ ${inp.speed} km/s, ⟨Bz⟩ ${inp.bz} nT, ⟨n⟩ ${inp.density} cm⁻³ · ${esc(row.model)} · lead ${Math.round((blockMs(row.block) - Date.parse(row.sealedAt)) / 60000)} min`)}</p>
      <div class="hash" style="margin-top:8px">${L(`lock code ${short(row.hash)}`, `fingerprint ${row.hash}`, `sha256 ${row.hash}`)}</div>${joeBox}`;
  }
  const btn = $('#joe-kp-seal');
  if (btn) btn.onclick = async () => {
    const kp = parseFloat($('#joe-kp').value);
    if (!(kp >= 0 && kp <= 9)) return toast(P('Pick a number from 0 to 9.', 'Pick a number from 0 to 9.', 'Kp must be in [0, 9].'));
    const block = S.nextBlock(Date.now());
    if (STATE.myGuesses.some((g) => g.block === block)) return toast(P('You already guessed this one!', 'You already sealed a guess for this window.'));
    btn.disabled = true;
    try {
      await store.append('seal', { kind: 'sky-guess', block, kp: +kp.toFixed(2), leadMinutes: Math.round((blockMs(block) - Date.now()) / 60000) });
      toast(P('Locked in! The real answer comes after this time window ends.', 'Sealed. Reality will score it after the window closes.', 'Sealed and submitted for OTS stamping; scored on SWPC publication.'));
      await load();
    } catch (e) { toast(e.message); btn.disabled = false; }
  };
}

function barRows(items, worst) {
  return items.map((it) => {
    const pct = it.mae == null ? 0 : Math.max(4, 100 - (it.mae / worst) * 100);
    return `<div class="bar-row"><div>${it.label}<div class="faint" style="font-size:12px">${L(`${it.n} checked`, `${it.n} scored`, `n = ${it.n}`)}</div></div>
      <div class="track"><div class="fill ${it.cls || ''}" style="width:${it.mae == null ? 0 : pct}%"></div></div>
      <div style="text-align:right"><b>${it.mae == null ? '—' : fx(it.mae, 2)}</b></div></div>`;
  }).join('');
}

function renderSkyScore() {
  const sb = STATE.board;
  const model = STATE.model;
  const items = [
    { label: L('Our helper', 'The Ladder', `The Ladder (${esc(model?.id)})`), ...sb.ladder },
    { label: L("NOAA's scientists", "NOAA's forecast", 'SWPC 3-day forecast'), cls: 'rival', ...sb.noaa },
    { label: L('"Same as last time"', 'Repeat the last value', 'Persistence'), cls: 'rival', ...sb.persistence },
    { label: L('You', 'You', 'You (this device)'), cls: 'joe', ...sb.you },
  ];
  const worst = Math.max(1.5, ...items.map((i) => i.mae || 0)) * 1.15;
  const n = sb.ladder.n;
  const note = n === 0
    ? L('Nothing checked yet. The real answer comes in soon after each 3-hour window ends. Then everyone gets checked automatically.',
        'No window has been scored yet. NOAA posts each measured Kp shortly after its 3-hour window closes, then the Checker scores everyone automatically.',
        'No blocks resolved yet. Resolution occurs when SWPC publishes preliminary Kp for a sealed block.')
    : n < 20
      ? L(`Only ${n} checked so far. That's too few to know who's really best. Even a coin can win a few times in a row. Check back in a few days.`,
          `Only ${n} window${n === 1 ? '' : 's'} scored so far, which is too few to call a winner. Give it a few days.`,
          `n = ${n}: far too small for a significant MAE difference; treat as anecdote. Target ≥ 50 blocks before comparing skill.`)
      : L('Now there are enough checks to start believing the scoreboard. Beating "same as last time" is the minimum. Beating NOAA would be amazing.',
          'Enough windows to start taking the scoreboard seriously. Beating "repeat the last value" is the minimum; beating NOAA would be remarkable.',
          'Sample size now supports a tentative comparison; persistence is the skill floor, SWPC the reference.');
  const w = model?.w || {};
  $('#sky-score').innerHTML = `<h3>${L("Who's winning?", 'Scoreboard', 'Mean absolute error')}</h3>
    <p class="muted" style="margin-top:0">${L('The number shows how far off each one was, on average. <b>Smaller is better.</b> A longer bar means a better score.', 'Average miss in Kp, so <b>lower is better</b>. A longer bar is a better score.', 'MAE in Kp units over resolved blocks; bar length ∝ skill.')}</p>
    ${barRows(items, worst)}
    <div class="note" style="margin-top:14px">${note}</div>
    <p class="faint" style="font-size:13px;margin-bottom:0">${L(
      "How our helper guesses: it uses a science formula about the Sun's wind, mixed with the last real measurement.",
      `Current model: <b>${esc(model?.id)}</b>. ${esc(model?.plain)}`,
      `Model ${esc(model?.id)}: Kp̂ = ${w.newell}·⟨Kp_Newell⟩₆₀ + ${w.persistence}·Kp_last + ${w.bias}. Newell et al. (2008): Kp = 0.05 + 2.244×10⁻⁴·dΦ/dt + 2.844×10⁻⁶·n^½v², dΦ/dt = v^{4/3}B_T^{2/3}sin^{8/3}(θ/2). Refit (ridge LSQ) every 8 resolved blocks after 12; new versions are sealed before use.`)}</p>`;
}

function renderSkyChart() {
  const lv = STATE.pub.live;
  if (!lv.trail?.length) { $('#sky-chart').innerHTML = `<div class="empty">${L('No data right now.', 'Waiting for data.')}</div>`; return; }
  const W = 1100, H = 260, Pd = { l: 44, r: 14, t: 14, b: 30 };
  const t0 = lv.trail[0].t, t1 = Math.max(Date.now(), lv.trail[lv.trail.length - 1].t) + 3 * 3600e3;
  const x = (t) => Pd.l + ((t - t0) / (t1 - t0)) * (W - Pd.l - Pd.r);
  const maxKp = Math.max(5, ...lv.observedRecent.map((o) => o.kp), ...STATE.rows.map((r) => r.prediction));
  const y = (k) => H - Pd.b - (Math.min(k, maxKp) / maxKp) * (H - Pd.t - Pd.b);
  let grid = '';
  for (let k = 0; k <= maxKp; k += 1) grid += `<line x1="${Pd.l}" x2="${W - Pd.r}" y1="${y(k)}" y2="${y(k)}" stroke="rgba(222,184,110,.1)"/><text x="${Pd.l - 8}" y="${y(k) + 4}" fill="#6f7898" font-size="11" text-anchor="end">${k}</text>`;
  const line = lv.trail.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.kp).toFixed(1)}`).join(' ');
  const obs = lv.observedRecent.filter((o) => blockMs(o.block) + 3 * 3600e3 > t0).map((o) => {
    const a = Math.max(x(blockMs(o.block)), Pd.l), b = x(blockMs(o.block) + 3 * 3600e3);
    return `<rect x="${a}" y="${y(o.kp)}" width="${Math.max(0, b - a - 2)}" height="${H - Pd.b - y(o.kp)}" fill="rgba(143,184,255,.16)" stroke="rgba(143,184,255,.55)"/>`;
  }).join('');
  const sealed = STATE.rows.filter((r) => blockMs(r.block) + 3 * 3600e3 > t0).map((r) => {
    const a = x(blockMs(r.block)), b = x(blockMs(r.block) + 3 * 3600e3);
    return `<line x1="${a}" x2="${b - 2}" y1="${y(r.prediction)}" y2="${y(r.prediction)}" stroke="#ffe2a3" stroke-width="3"/><circle cx="${(a + b) / 2}" cy="${y(r.prediction)}" r="4" fill="#ffe2a3"/>`;
  }).join('');
  const now = x(Date.now());
  let ticks = '';
  for (let t = Math.ceil(t0 / (6 * 3600e3)) * 6 * 3600e3; t < t1; t += 6 * 3600e3) ticks += `<text x="${x(t)}" y="${H - 10}" fill="#6f7898" font-size="11" text-anchor="middle">${timeFmt.format(new Date(t))}</text>`;
  $('#sky-chart').innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Solar wind driving versus measured storm level">${grid}${obs}
    <path d="${line}" fill="none" stroke="#e9c47c" stroke-width="1.6" opacity=".85"/>${sealed}
    <line x1="${now}" x2="${now}" y1="${Pd.t}" y2="${H - Pd.b}" stroke="rgba(255,255,255,.35)" stroke-dasharray="4 4"/><text x="${now + 6}" y="${Pd.t + 10}" fill="#a5adc8" font-size="11">now</text>${ticks}</svg>
    <div class="legend">
      <span><i style="background:#e9c47c"></i>${L("What the Sun's wind says, minute by minute", 'What the solar wind says, minute by minute (physics formula)', 'Kp_Newell from 1-min RTSW (sampled every 10 min)')}</span>
      <span><i style="background:rgba(143,184,255,.8)"></i>${L('The real storm level', 'Measured Kp per 3-hour window', 'Observed planetary Kp (preliminary), 3-h blocks')}</span>
      <span><i style="background:#ffe2a3;height:5px"></i>${L("Our helper's locked-in guesses", "The Ladder's sealed calls", 'Sealed forecasts')}</span></div>`;
}

function renderSkyTable() {
  const rows = [...STATE.rows].reverse();
  if (!rows.length) { $('#sky-table').innerHTML = `<div class="empty">${L('No guesses yet.', 'No calls sealed yet.')}</div>`; return; }
  const guessBy = Object.fromEntries(STATE.myGuesses.map((g) => [g.block, g]));
  const names = { Ladder: L('Our helper', 'Ladder'), NOAA: L('NOAA', 'NOAA', 'SWPC'), Repeat: L('Same as last', 'Repeat', 'Persistence'), You: 'You' };
  $('#sky-table').innerHTML = `<table><thead><tr>
      <th>${L('When', 'Window', 'Block')}</th><th>${L('Our helper', 'Ladder')}</th><th>${L('NOAA', 'NOAA', 'SWPC')}</th><th>${L('Same as last', 'Repeat', 'Persist.')}</th><th>You</th><th>${L('Real answer', 'Measured', 'Observed')}</th><th>${L('Closest', 'Closest', 'Min |err|')}</th></tr></thead><tbody>${rows.map((r) => {
    const g = guessBy[r.block];
    let best = [];
    if (r.errors) {
      const c = [['Ladder', r.errors.ladder], ['NOAA', r.errors.noaa], ['Repeat', r.errors.persistence]];
      if (g) c.push(['You', Math.abs(g.kp - r.observed)]);
      const valid = c.filter((e) => e[1] != null);
      const min = Math.min(...valid.map((e) => e[1]));
      best = valid.filter((e) => e[1] === min).map((e) => e[0]);
    }
    return `<tr class="${best.includes('Ladder') ? 'win' : ''}"><td>${windowWords(r.block)}<div class="hash">${short(r.hash)}</div></td><td><b>${fx(r.prediction)}</b></td><td>${r.rivals.noaa ? fx(r.rivals.noaa.kp) : '—'}</td><td>${fx(r.rivals.persistence)}</td><td>${g ? fx(g.kp) : '—'}</td><td>${r.observed == null ? `<span class="faint">${L('coming soon', 'waiting', 'pending')}</span>` : `<b>${fx(r.observed)}</b>`}</td><td>${best.length ? best.map((b) => names[b]).join(', ') : '<span class="faint">—</span>'}</td></tr>`;
  }).join('')}</tbody></table>`;
}

// ---------- desk ----------
function heliSVG(d, scale = 9) {
  const W = d.W * scale, Ln = d.L * scale, Lb = d.Lb * scale, pad = 10;
  const w = 2 * W + pad * 2, h = Ln + Lb + pad * 2;
  return `<svg class="heli" viewBox="0 0 ${w} ${h}" aria-label="Helicopter cut-out">
    <rect x="${pad}" y="${pad}" width="${2 * W}" height="${Ln + Lb}" fill="rgba(255,250,235,.92)" stroke="#e9c47c"/>
    <line x1="${pad + W}" y1="${pad}" x2="${pad + W}" y2="${pad + Ln}" stroke="#ff5a5a" stroke-width="2"/>
    <line x1="${pad}" y1="${pad + Ln}" x2="${pad + W / 2}" y2="${pad + Ln}" stroke="#ff5a5a" stroke-width="2"/>
    <line x1="${pad + 2 * W}" y1="${pad + Ln}" x2="${pad + 1.5 * W}" y2="${pad + Ln}" stroke="#ff5a5a" stroke-width="2"/>
    <line x1="${pad}" y1="${pad + Ln}" x2="${pad + 2 * W}" y2="${pad + Ln}" stroke="#3b6fd8" stroke-dasharray="5 4"/>
    <line x1="${pad + W / 2}" y1="${pad + Ln}" x2="${pad + W / 2}" y2="${pad + Ln + Lb}" stroke="#3b6fd8" stroke-dasharray="5 4"/>
    <line x1="${pad + 1.5 * W}" y1="${pad + Ln}" x2="${pad + 1.5 * W}" y2="${pad + Ln + Lb}" stroke="#3b6fd8" stroke-dasharray="5 4"/>
    <text x="${pad + W / 2}" y="${pad + Ln / 2}" fill="#9a8a6a" font-size="18" text-anchor="middle">A</text>
    <text x="${pad + 1.5 * W}" y="${pad + Ln / 2}" fill="#9a8a6a" font-size="18" text-anchor="middle">B</text></svg>`;
}

function dims(d, extra = '') {
  return `<div class="design-dims">
    <div class="stat"><div class="k">${L('Wing length', 'Blade length', 'Rotor length L')}</div><div class="v">${d.L} <small>cm</small></div></div>
    <div class="stat"><div class="k">${L('Wing width', 'Blade width', 'Rotor width W')}</div><div class="v">${d.W} <small>cm</small></div></div>
    <div class="stat"><div class="k">${L('Body length', 'Body length', 'Body length L_b')}</div><div class="v">${d.Lb} <small>cm</small></div></div>${extra}</div>`;
}

const goalWords = (g) => ({ standard: L('the classic shape', 'standard'), longest: L('the longest flight', 'longest flight'), target: L('an exact time', 'target time') })[g] || esc(g);

function deskInputs() {
  return { height: parseFloat($('#d-height')?.value) || 2.4, clip: $('#d-clip')?.value || 'small', goal: $('#d-goal')?.value, target: parseFloat($('#d-target')?.value) || 2 };
}

function makePlan(q) {
  const heightM = Math.min(6, Math.max(1, Number(q.height) || 2.4));
  const clip = desk.CLIPS[q.clip] ? q.clip : 'small';
  const goal = ['standard', 'longest', 'target'].includes(q.goal) ? q.goal : (STATE.rounds.length === 0 ? 'standard' : 'longest');
  const targetSeconds = Math.min(8, Math.max(0.8, Number(q.target) || 2));
  return desk.design(goal, { heightM, clip, targetSeconds, cal: STATE.calibration.raw });
}

function openTemplate(design, heightM, clip, seal) {
  const svg = desk.templateSVG(design, { heightM, clip, seal });
  window.open(URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })), '_blank');
}

function renderDesk() {
  const open = STATE.open;
  if (open) {
    const p = open.prediction;
    $('#desk-flow').innerHTML = `<h3>${L(`Round ${open.round}: both guesses are locked. Time to drop it!`, `Round ${open.round} is sealed. Go drop it.`, `Round ${open.round}: sealed, awaiting measurement`)}</h3>
      <div class="steps">
        <div class="step done"><div class="n">✓</div><div><b>${L('Shape picked', 'Designed', 'Design')}</b> · ${goalWords(open.goal)}${dims(open.design)}</div></div>
        <div class="step done"><div class="n">✓</div><div><b>${L('Guesses locked in', 'Both guesses sealed', 'Predictions sealed')}</b><div class="row" style="margin-top:8px">
          <div class="stat"><div class="k">${L('Our helper', 'The Predictor', 'Model')}</div><div class="v">${fx(p.seconds)} <small>${L('seconds', 's')}</small></div><div class="s">${L(`Probably between ${fx(p.low)} and ${fx(p.high)} seconds`, `80% sure: ${fx(p.low)}–${fx(p.high)} s`, `80% PI [${fx(p.low)}, ${fx(p.high)}] s · σ(ln t) = ${p.sdLnT}`)}</div></div>
          <div class="stat"><div class="k">You</div><div class="v" style="color:var(--violet)">${open.joeGuess ? fx(open.joeGuess) : '—'} <small>${L('seconds', 's')}</small></div><div class="s">${open.joeGuess ? L("locked before you saw the helper's guess", 'sealed before you saw the tool', 'sealed blind to model output') : L('no guess this time', 'no guess this round')}</div></div></div>
          <div class="hash" style="margin-top:6px">${L(`lock code ${short(open.hash)}`, `fingerprint ${open.hash}`, `sha256 ${open.hash}`)}${stampedMark(open.hash)}</div></div></div>
        <div class="step"><div class="n">3</div><div><b>${L('Make it.', 'Make it.', 'Build.')}</b> <button class="ghost" id="d-template" style="padding:6px 12px;font-size:14px">${L('Open the cut-out to print', 'Open the cut-out template', 'Template (1:1, US Letter)')}</button>
          <p class="muted" style="margin:8px 0 0;font-size:14px">${L(
            `No printer? Use a ruler to draw a rectangle ${2 * open.design.W} cm wide and ${open.design.L + open.design.Lb} cm tall. Then copy the red cut lines and the blue fold lines from the picture.`,
            `No printer? Draw a ${2 * open.design.W} × ${open.design.L + open.design.Lb} cm rectangle with a ruler and copy the red cuts and blue folds from the picture on the right.`,
            `Hand layout: ${2 * open.design.W} × ${open.design.L + open.design.Lb} cm blank; center slit L, side slits W/2, folds per diagram. 75 g/m² stock assumed.`)}</p></div></div>
        <div class="step"><div class="n">4</div><div><b>${L(`Drop it 3 times from ${open.heightM} meters`, `Drop it 3 times from ${open.heightM} m`, `3 drops from h = ${open.heightM} m`)}</b>, ${L('wings up. Time it from when you let go until it touches the floor.', 'blades up. Time from release to floor.', 'release from rest; time to floor contact.')}
          <div class="row" style="margin-top:10px"><input id="t1" type="number" step="0.01" placeholder="1st, s"><input id="t2" type="number" step="0.01" placeholder="2nd, s"><input id="t3" type="number" step="0.01" placeholder="3rd, s"></div>
          <input id="t-note" style="margin-top:10px" placeholder="${P('Did anything weird happen? (optional)', 'Anything odd? (optional: e.g. it tumbled, hit the wall)', 'Anomalies (optional)')}">
          <div style="margin-top:12px"><button id="d-score">${L('See who was closer', 'Score it', 'Score')}</button></div></div></div>
      </div>`;
    $('#d-template').onclick = () => openTemplate(open.design, open.heightM, open.clip, open.hash);
    $('#d-score').onclick = async () => {
      const times = ['#t1', '#t2', '#t3'].map((s) => parseFloat($(s).value)).filter((t) => t > 0 && t < 30);
      if (!times.length) return toast(P('Type at least one time, in seconds.', 'Enter at least one time in seconds.'));
      const seal = store.entries.find((e) => e.hash === open.hash);
      const b = S.scoreRound(seal, times, $('#t-note').value);
      try {
        await store.append('result', b);
        toast(P(
          `It fell in ${fx(b.mean)} seconds! The helper was off by ${b.toolErrorPct}%${b.joeErrorPct != null ? `, and you were off by ${b.joeErrorPct}%` : ''}. The helper just learned from it.`,
          `Measured ${fx(b.mean)} s. Tool off by ${b.toolErrorPct}%${b.joeErrorPct != null ? `, you by ${b.joeErrorPct}%` : ''}. The tool just learned from it.`,
          `t̄ = ${fx(b.mean, 3)} s; model err ${b.toolErrorPct}%${b.joeErrorPct != null ? `, human err ${b.joeErrorPct}%` : ''}; posterior updated.`));
        PLAN = null; await load(); render(true);
      } catch (e) { toast(e.message); }
    };
    $('#desk-side').innerHTML = `<h3>${L('Your helicopter', 'Your cut-out', 'Layout')}</h3>${heliSVG(open.design)}<p class="faint" style="text-align:center;font-size:13px">${L('Red lines: cut. Blue dashes: fold. Fold wing A toward you and wing B away.', 'Red: cut · Blue dashes: fold · Fold A toward you, B away', 'Red: cut · Blue: fold · A/B folded opposite for autorotation')}</p>${deskLearned()}`;
    return;
  }

  const first = STATE.rounds.length === 0;
  const last = STATE.rounds[STATE.rounds.length - 1];
  const hadForm = !!$('#d-goal');
  const prev = deskInputs();
  const height = hadForm ? prev.height : (last?.heightM ?? 2.4);
  $('#desk-flow').innerHTML = `<h3>${first ? L('Round 1: the classic paper helicopter', 'Round 1: the standard helicopter', 'Round 1: baseline geometry') : `Round ${STATE.rounds.length + 1}`}</h3>
    <div class="row">
      <div><label for="d-height">${L('How high you will drop it from (meters). Holding it up while standing on a chair is about 2.4.', 'Drop height (m)', 'Drop height h (m)')}</label><input id="d-height" type="number" step="0.1" min="1" max="6" value="${height}"></div>
      <div><label for="d-clip">${L('Paper clip size', 'Paper clip', 'Ballast')}</label><select id="d-clip"><option value="small">${P('Small', 'Small (about 0.45 g)', 'Small clip, 0.45 g')}</option><option value="large">${P('Large', 'Large (about 1.4 g)', 'Large clip, 1.4 g')}</option></select></div>
    </div>
    <div class="row" style="margin-top:10px">
      <div><label for="d-goal">${L('What should the helper design?', 'Ask the Designer for', 'Objective')}</label><select id="d-goal">
        <option value="standard">${P('The classic shape (do this first)', 'Standard shape (do first)', 'Baseline (calibration)')}</option>
        <option value="longest">${P('The longest flight', 'Longest flight', 'argmax t')}</option>
        <option value="target">${P('An exact flight time', 'An exact flight time', 'argmin |t − t*|')}</option></select></div>
      <div id="d-target-wrap"><label for="d-target">${L('How many seconds?', 'Target time (s)', 'Target t* (s)')}</label><input id="d-target" type="number" step="0.1" min="0.8" max="8" value="2.5"></div>
    </div>
    <div style="margin-top:12px"><button id="d-plan">${L('Ask the helper', 'Ask the Designer', 'Run Designer')}</button></div>
    <div id="d-plan-out" style="margin-top:14px"></div>`;
  $('#d-clip').value = hadForm ? prev.clip : (last?.clip ?? 'small');
  $('#d-goal').value = hadForm ? prev.goal : (first ? 'standard' : 'longest');
  if (hadForm) $('#d-target').value = prev.target;
  const syncTarget = () => { $('#d-target-wrap').style.visibility = $('#d-goal').value === 'target' ? 'visible' : 'hidden'; };
  $('#d-goal').onchange = () => { syncTarget(); PLAN = null; $('#d-plan-out').innerHTML = ''; };
  syncTarget();
  $('#d-plan').onclick = () => { PLAN = makePlan(deskInputs()); showPlan(); };
  if (PLAN) showPlan();
  $('#desk-side').innerHTML = `<h3>${L('How to time a drop', 'How to time a drop', 'Measurement protocol')}</h3>
    <ul class="muted" style="padding-left:18px;margin-top:0">${L(
      '<li>Stand somewhere safe and steady, like a sturdy chair or the stairs. Ask a grown-up to help if you need it.</li><li>Hold it by the body, with the wings spread out flat.</li><li>Let go. Don\'t throw it!</li><li>Start a phone timer when you let go. Stop it when it touches the floor.</li><li>Stay away from fans. Drop it 3 times.</li>',
      '<li>Stand on something steady, or drop from a stair landing. Measure the height to the floor.</li><li>Hold it by the body with the blades folded out and level. Let go, don\'t throw.</li><li>Start your phone stopwatch as you let go and stop it when it touches the floor.</li><li>Away from fans and vents. Three drops, then enter all three.</li>',
      '<li>Measure h to the floor (±2 cm).</li><li>Release from rest, rotor horizontal; no imparted velocity.</li><li>Manual timing adds ~±0.1 s per drop (reaction time); the mean of 3 reduces it.</li><li>Still air; drafts bias C_d. Note anomalies (tumble, wall contact) for exclusion.</li>')}</ul>${deskLearned()}`;
}

function showPlan() {
  const p = PLAN;
  const typed = showPlan.typed || '';
  const whyEasy = p.goal === 'standard'
    ? 'This is the classic shape. We start with it so the helper can learn how your paper and your room behave.'
    : p.goal === 'longest'
      ? `The helper tried ${p.searched} shapes and picked the one that should stay in the air the longest.`
      : `The helper tried ${p.searched} shapes and picked the one that should come closest to your time.`;
  $('#d-plan-out').innerHTML = `<div class="note">${L(whyEasy, esc(p.why), `${esc(p.why)} Prior/posterior C_d = ${p.calibration.cd} (σ_ln = ${p.calibration.sd}, ${p.calibration.drops} rounds).`)}</div>
    <div class="grid2" style="margin-top:12px;align-items:center">${dims(p.design, `<div class="stat"><div class="k">${L('Weight', 'Weight', 'Mass')}</div><div class="v">${p.massGrams} <small>g</small></div></div>`)}<div>${heliSVG(p.design, 7)}</div></div>
    <label for="d-joe" style="margin-top:12px">${L(
      `Your turn first! How many seconds will it take to fall ${p.heightM} meters? The helper's guess stays hidden until you lock yours in.`,
      `Your guess first: how many seconds will it take to fall ${p.heightM} m? The tool's guess stays hidden until both are sealed.`,
      `Human forecast for t (s) at h = ${p.heightM} m; sealed jointly with the model prediction, which stays hidden until then.`)}</label>
    <div class="row"><input id="d-joe" type="number" step="0.1" min="0.3" max="20" placeholder="e.g. 2.0" value="${esc(typed)}"><button id="d-seal" style="flex:0 0 auto">${L('Lock in both guesses', 'Seal both guesses', 'Seal')}</button></div>`;
  $('#d-joe').oninput = (ev) => { showPlan.typed = ev.target.value; };
  $('#d-seal').onclick = async () => {
    const joeGuess = parseFloat($('#d-joe').value);
    const fresh = makePlan(deskInputs());
    try {
      const e = await store.append('seal', { kind: 'desk', goal: fresh.goal, design: fresh.design, heightM: fresh.heightM, clip: fresh.clip, massGrams: fresh.massGrams, prediction: fresh.prediction, calibration: fresh.calibration, joeGuess: joeGuess > 0 ? +joeGuess.toFixed(2) : null, why: fresh.why });
      toast(P(`Locked! The helper guessed ${fx(e.body.prediction.seconds)} seconds.`, `Sealed. The Predictor says ${fx(e.body.prediction.seconds)} s.`, `Sealed: t̂ = ${fx(e.body.prediction.seconds)} s.`));
      PLAN = null; showPlan.typed = ''; await load(); render(true);
    } catch (err) { toast(err.message); }
  };
}

function deskLearned() {
  const c = STATE.calibration;
  const scored = STATE.rounds.filter((r) => r.result);
  let chart = `<div class="empty">${L('After your first drop, a line here will show if the helper is getting better.', 'The learning curve appears after your first scored round.', 'Error-by-round plot appears after the first resolved round.')}</div>`;
  if (scored.length) {
    const W = 520, H = 170, Pd = { l: 36, r: 10, t: 12, b: 26 };
    const maxE = Math.max(20, ...scored.map((r) => Math.max(r.result.toolErrorPct, r.result.joeErrorPct ?? 0))) * 1.1;
    const x = (i) => Pd.l + (scored.length === 1 ? (W - Pd.l - Pd.r) / 2 : (i / (scored.length - 1)) * (W - Pd.l - Pd.r));
    const y = (e) => H - Pd.b - (e / maxE) * (H - Pd.t - Pd.b);
    const path = (k) => scored.map((r, i) => (r.result[k] == null ? '' : `${i && scored[i - 1].result[k] != null ? 'L' : 'M'}${x(i)},${y(r.result[k])}`)).join(' ');
    const dots = (k, col) => scored.map((r, i) => (r.result[k] == null ? '' : `<circle cx="${x(i)}" cy="${y(r.result[k])}" r="4" fill="${col}"/>`)).join('');
    chart = `<svg class="chart" viewBox="0 0 ${W} ${H}"><line x1="${Pd.l}" x2="${W - Pd.r}" y1="${y(0)}" y2="${y(0)}" stroke="rgba(222,184,110,.25)"/>
      <text x="${Pd.l - 6}" y="${y(0) + 4}" font-size="11" fill="#6f7898" text-anchor="end">0%</text><text x="${Pd.l - 6}" y="${y(maxE / 1.1) + 4}" font-size="11" fill="#6f7898" text-anchor="end">${Math.round(maxE / 1.1)}%</text>
      <path d="${path('toolErrorPct')}" stroke="#ffe2a3" stroke-width="2.5" fill="none"/>${dots('toolErrorPct', '#ffe2a3')}
      <path d="${path('joeErrorPct')}" stroke="#c4a6ff" stroke-width="2" fill="none" stroke-dasharray="5 4"/>${dots('joeErrorPct', '#c4a6ff')}
      ${scored.map((r, i) => `<text x="${x(i)}" y="${H - 8}" font-size="11" fill="#6f7898" text-anchor="middle">R${r.round}</text>`).join('')}</svg>
      <div class="legend"><span><i style="background:#ffe2a3"></i>${L('How far off the helper was', "Tool's miss", 'Model |err| %')}</span><span><i style="background:#c4a6ff"></i>${L('How far off you were', 'Your miss', 'Human |err| %')}</span></div>`;
  }
  const pct = Math.round(c.sd * 100);
  return `<h3 style="margin-top:18px">${L('What the helper has learned', 'What the tool has learned', 'Calibration state')}</h3>
    <p class="muted" style="margin-top:0;font-size:14px">${L(
      c.drops ? `It's learning how much the air slows your helicopter down. After ${c.drops} round${c.drops === 1 ? '' : 's'} with you, it's getting more sure of itself.` : "It's learning how much the air slows your helicopter down. Right now it's only guessing, so it might be quite far off.",
      `It learns one number: how hard the air pushes back on your helicopter's blades. ${c.drops ? `After ${c.drops} scored round${c.drops === 1 ? '' : 's'} it's <b>${c.cd}</b>, with its uncertainty down to ±${pct}%.` : `Before any drops it starts from a textbook-style guess, ${c.cd}, and admits it could be off by ±${pct}%.`}`,
      `Model: mg = ½ρC_dAv² (A = 2LW blade area, ρ = 1.2 kg/m³), t = h/v + v/2g. Conjugate normal update on ln C_d per round (model σ = 0.22). Posterior C_d = ${c.cd}, σ_ln = ${c.sd}, from ${c.drops} round${c.drops === 1 ? '' : 's'}.`)}</p>${chart}`;
}

function renderDeskTable() {
  const rounds = [...STATE.rounds].reverse();
  if (!rounds.length) { $('#desk-table').innerHTML = `<div class="empty">${L('No rounds yet. Round 1 takes about ten minutes. Give it a try!', 'No rounds yet. Round 1 takes about ten minutes.', 'No rounds recorded.')}</div>`; return; }
  $('#desk-table').innerHTML = `<table><thead><tr><th>${L('Round', 'Round', '#')}</th><th>${L('Shape', 'Shape', 'Geometry')}</th><th>${L("Helper's guess", "Tool's guess", 't̂ (80% PI)')}</th><th>${L('Your guess', 'Your guess', 'Human')}</th><th>${L('Real time', 'Measured', 't̄ (drops)')}</th><th>${L('Helper was off by', 'Tool missed by', 'Model err')}</th><th>${L('You were off by', 'You missed by', 'Human err')}</th></tr></thead><tbody>${rounds.map((r) => `<tr class="${r.result && r.result.joeErrorPct != null && r.result.toolErrorPct < r.result.joeErrorPct ? 'win' : ''}">
    <td>R${r.round}<div class="hash">${short(r.hash)}</div></td><td>${r.design.L}×${r.design.W} ${L('wings', 'blades')}, ${r.design.Lb} body<div class="faint" style="font-size:12px">${goalWords(r.goal)}, ${r.heightM} m</div></td>
    <td><b>${fx(r.prediction.seconds)} s</b><div class="faint" style="font-size:12px">${fx(r.prediction.low)}–${fx(r.prediction.high)}</div></td>
    <td>${r.joeGuess ? fx(r.joeGuess) + ' s' : '—'}</td>
    <td>${r.result ? `<b>${fx(r.result.mean)} s</b><div class="faint" style="font-size:12px">${r.result.times.map((t) => fx(t)).join(' · ')}</div>` : `<span class="faint">${L('not dropped yet', 'not dropped yet', 'pending')}</span>`}</td>
    <td>${r.result ? `${r.result.toolErrorPct}% ${r.result.insideRange ? `<span class="good">${L('good guess', 'in range', 'in PI')}</span>` : `<span class="bad">${L('surprised it', 'outside range', 'outside PI')}</span>`}` : '—'}</td>
    <td>${r.result && r.result.joeErrorPct != null ? r.result.joeErrorPct + '%' : '—'}</td></tr>`).join('')}</tbody></table>`;
}

// ---------- ladder ----------
function renderLadder() {
  const rs = STATE.rungs;
  $('#rungs').innerHTML = rs.length
    ? rs.map((r) => `<div class="rung-item"><div class="mark">${r.kind === 'sky' ? '☉' : '✦'}</div><div>${L(esc(r.simple), esc(r.text), esc(r.expert))}<div class="faint" style="font-size:12px">${L(`proven by ${r.n} real check${r.n === 1 ? '' : 's'}`, `from ${r.n} sealed, scored result${r.n === 1 ? '' : 's'}`, `n = ${r.n} resolved`)}</div></div></div>`).join('')
    : `<div class="empty">${L('Nothing here yet. The first step gets written down by itself as soon as a guess is checked.', 'No rungs yet. The first one is written automatically when the first guess gets scored.')}</div>`;
  const notes = store.entries.filter((e) => e.type === 'rung').reverse();
  $('#notes').innerHTML = notes.map((n) => `<div class="rung-item"><div class="mark">✎</div><div>${esc(n.body.text)}${n.body.evidence ? `<div class="faint" style="font-size:13px">${esc(n.body.evidence)}</div>` : ''}<div class="hash">${ago(n.at)} · ${short(n.hash)}${stampedMark(n.hash)}</div></div></div>`).join('');
}

// ---------- lockers ----------
function summarize(e) {
  const b = e.body;
  if (e.type === 'model') return L(`A new way of guessing was locked in: ${esc(b.plain)}`, `Model sealed: <b>${esc(b.id)}</b>. ${esc(b.plain)}`, `Model <b>${esc(b.id)}</b>${b.w ? ` w = ${esc(JSON.stringify(b.w))}` : ''}${b.prior ? ` prior C_d ${b.prior.cd}, σ_ln ${b.prior.sdLog}` : ''}`);
  if (e.type === 'seal' && b.kind === 'sky') return L(`Space guess for ${windowWords(b.block)}: <b>${fx(b.prediction)}</b> out of 9 (NOAA said ${b.rivals.noaa ? fx(b.rivals.noaa.kp) : '—'})`, `Sky call for ${windowWords(b.block)}: <b>Kp ${fx(b.prediction)}</b> (NOAA ${b.rivals.noaa ? fx(b.rivals.noaa.kp) : '—'}, repeat ${fx(b.rivals.persistence)})`, `Kp̂(${esc(b.block)}Z) = <b>${fx(b.prediction)}</b> · SWPC ${b.rivals.noaa ? fx(b.rivals.noaa.kp) : 'n/a'} · persist ${fx(b.rivals.persistence)} · lead ${b.leadMinutes} min`);
  if (e.type === 'seal' && b.kind === 'sky-guess') return L(`Your space guess for ${windowWords(b.block)}: <b>${fx(b.kp)}</b>`, `Your sky guess for ${windowWords(b.block)}: <b>Kp ${fx(b.kp)}</b>`, `Human Kp(${esc(b.block)}Z) = <b>${fx(b.kp)}</b>`);
  if (e.type === 'seal' && b.kind === 'desk') return L(`Helicopter guess: helper said <b>${fx(b.prediction.seconds)} s</b>${b.joeGuess ? `, you said <b>${fx(b.joeGuess)} s</b>` : ''}`, `Helicopter ${b.design.L}×${b.design.W}/${b.design.Lb} cm: tool says <b>${fx(b.prediction.seconds)} s</b> (${fx(b.prediction.low)}–${fx(b.prediction.high)})${b.joeGuess ? `, you say <b>${fx(b.joeGuess)} s</b>` : ''}`, `Desk L/W/L_b ${b.design.L}/${b.design.W}/${b.design.Lb} cm, h ${b.heightM} m: t̂ ${fx(b.prediction.seconds)} [${fx(b.prediction.low)}, ${fx(b.prediction.high)}]${b.joeGuess ? `; human ${fx(b.joeGuess)}` : ''}`);
  if (e.type === 'result' && b.kind === 'desk') return L(`It really fell in <b>${fx(b.mean)} s</b>. Helper off by ${b.toolErrorPct}%${b.joeErrorPct != null ? `, you off by ${b.joeErrorPct}%` : ''}`, `Dropped: ${b.times.map((t) => fx(t)).join(', ')} s → mean <b>${fx(b.mean)} s</b>. Tool off ${b.toolErrorPct}%${b.joeErrorPct != null ? `, you off ${b.joeErrorPct}%` : ''}`, `t = [${b.times.map((t) => fx(t)).join(', ')}], t̄ <b>${fx(b.mean, 3)}</b>; err model ${b.toolErrorPct}%${b.joeErrorPct != null ? `, human ${b.joeErrorPct}%` : ''}; in PI: ${b.insideRange}`);
  if (e.type === 'result') return L(`The real answer for ${windowWords(b.block)} was <b>${fx(b.observed)}</b>.`, `Measured Kp <b>${fx(b.observed)}</b> for ${windowWords(b.block)}. Misses: ${Object.entries(b.errors).map(([k, v]) => `${k} ${v == null ? '—' : fx(v)}`).join(', ')}`, `Kp_obs(${esc(b.block)}Z) = <b>${fx(b.observed)}</b> · |err| ${Object.entries(b.errors).map(([k, v]) => `${k} ${v == null ? 'n/a' : fx(v)}`).join(', ')}`);
  if (e.type === 'rung') return `${L('Step', 'Rung', 'Rung')}: ${esc(b.text)}`;
  return esc(e.type);
}

const typeWord = (t) => ({ seal: L('locked', 'seal', 'seal'), result: L('answer', 'result', 'result'), model: L('method', 'model', 'model'), rung: L('step', 'rung', 'rung') })[t] || esc(t);
const entryList = (entries, stampedHashes) => [...entries].reverse().slice(0, 40).map((e) => `<div class="entry"><div class="faint">#${e.seq}</div><div class="when"><div class="type">${typeWord(e.type)}</div><div class="faint" style="font-size:12px">${ago(e.at)}</div></div><div>${summarize(e)}<div class="hash">${L(short(e.hash), e.hash, e.hash)}${stampedHashes.has(e.hash) ? ` <span class="good">${L('· stamped ✓', '· time-stamped ✓', '· OTS ✓')}</span>` : ''}</div></div></div>`).join('');

function verifyLine(v, words) {
  return v.ok
    ? `<div class="good" style="font-size:17px">✓ ${L(`Nothing has been changed. All ${v.count} ${words[0]} are safe.`, `Chain intact: all ${v.count} entries check out.`, `Verified ${v.count} entries; every hash recomputes and links.`)}</div>`
    : `<div class="bad" style="font-size:17px">✗ ${esc(v.problem)}</div>`;
}

function renderLockers() {
  const { pub } = STATE;
  const stamped = new Set(pub.stamps.map((s) => s.hash));
  const last = pub.stamps[pub.stamps.length - 1];
  const base = location.hostname.endsWith('github.io') ? './' : PUBLIC_SITE;
  $('#locker-public-verify').innerHTML = `${verifyLine(pub.verify, ['entries'])}<div class="hash">${L('', `head ${pub.verify.head}`, `head ${pub.verify.head}`)}</div>`;
  $('#locker-proof').innerHTML = last
    ? `<div class="note">${L(
        `Every few hours, this record's newest lock code is sent to public time-stamp servers. They tie it into Bitcoin's history, which nobody can change. That proves these guesses were made <b>before</b> the answers came in. Last stamp: <b>${ago(last.at)}</b>.`,
        `Each time the record grows, its newest fingerprint is stamped with <b>OpenTimestamps</b>, which ties it into the Bitcoin blockchain. That's public proof the guesses existed before the answers. Last stamp: entry #${last.seq}, <b>${ago(last.at)}</b>.`,
        `Head hashes are anchored via OpenTimestamps (${pub.stamps.length} proofs; calendars: ${esc(last.calendars.join(', '))}). Proofs are pending until the calendars commit to a Bitcoin block (hours); verify with <code>ots verify -d &lt;hash&gt; file.ots</code>.`)}
        <div style="margin-top:8px"><a class="btn ghost" style="padding:6px 12px;font-size:14px" href="${base}data/${esc(last.file)}" download>${L('Download the latest proof', 'Download latest proof (.ots)', `${esc(last.file)}`)}</a> <a class="btn ghost" style="padding:6px 12px;font-size:14px" href="${REPO}" target="_blank" rel="noopener">${L('See everything on GitHub', 'Open the public repository', 'Repository')}</a></div></div>`
    : `<div class="note">${L('The first public stamp is on its way.', 'The first public stamp happens on the engine\'s next run.', 'No OTS proofs yet.')}</div>`;
  $('#locker-public-list').innerHTML = entryList(pub.entries, stamped);

  const mine = new Set(Object.keys(store.stamps));
  const where = store.mode === 'local'
    ? L('Your own guesses and helicopter rounds are saved privately on this computer.', 'Your record is saved privately on this PC (The-Ladder\\data). It is never uploaded.', 'Personal chain: data/personal-locker.jsonl (local only, git-ignored).')
    : store.durable
      ? L('Your own guesses are saved only in this web browser, on this device. Nobody else can see them. Download a copy to keep them safe.', 'Your record lives only in this browser on this device. Download a copy to keep it.', 'Personal chain persisted in localStorage on this origin; export to retain.')
      : L("This browser won't let the page save anything, so your guesses will disappear when you close it.", 'This browser blocks saving, so your record lasts only until you close the page.', 'localStorage unavailable; in-memory only.');
  $('#locker-mine').innerHTML = `${verifyLine(STATE.personalVerify, ['of your entries'])}
    <p class="muted" style="margin:6px 0 10px">${where} ${L('Only a lock code (never your guess itself) goes to the public time-stamp servers.', 'Only each entry\'s fingerprint, never its contents, is sent for public time-stamping.', 'Only SHA-256 digests leave the device (to OTS calendars).')}</p>
    <div style="margin-bottom:8px"><button class="ghost" id="mine-download" style="padding:6px 12px;font-size:14px">${L('Download my record', 'Download my record', 'Export')}</button></div>
    ${store.entries.length ? entryList(store.entries, mine) : `<div class="empty">${L('Nothing here yet. Make a guess above!', 'Empty so far.', 'Empty.')}</div>`}`;
  $('#mine-download').onclick = () => store.download();
}

// ---------- draw everything ----------
function render(forceDesk = false) {
  if (!STATE) return;
  renderChips();
  renderSkyLive();
  renderSkySeal();
  renderSkyScore();
  renderSkyChart();
  renderSkyTable();
  const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest('#desk-flow');
  if (forceDesk || !focused) renderDesk();
  renderDeskTable();
  renderLadder();
  renderLockers();
}

$('#rung-add').onclick = async () => {
  const text = $('#rung-text').value.trim().slice(0, 400);
  if (!text) return toast(P('Write down what you can do now.', 'Write what you can do now.'));
  try {
    await store.append('rung', { text, evidence: $('#rung-ev').value.trim().slice(0, 400) || undefined });
    $('#rung-text').value = ''; $('#rung-ev').value = '';
    toast(P('Locked in!', 'Rung sealed.')); await load();
  } catch (e) { toast(e.message); }
};

// starfield
(function stars() {
  const c = $('#stars'), ctx = c.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let pts = [];
  const resize = () => {
    c.width = innerWidth * devicePixelRatio; c.height = innerHeight * devicePixelRatio;
    pts = Array.from({ length: Math.round((innerWidth * innerHeight) / 5200) }, () => ({ x: Math.random() * c.width, y: Math.random() * c.height, r: Math.random() * 1.3 + 0.2, p: Math.random() * 6.28, s: 0.4 + Math.random() * 1.2, g: Math.random() < 0.18 }));
  };
  const draw = (t) => {
    ctx.fillStyle = '#070b18'; ctx.fillRect(0, 0, c.width, c.height);
    const grd = ctx.createRadialGradient(c.width * 0.75, c.height * 0.1, 0, c.width * 0.75, c.height * 0.1, c.width * 0.7);
    grd.addColorStop(0, 'rgba(70,60,140,0.22)'); grd.addColorStop(1, 'rgba(7,11,24,0)');
    ctx.fillStyle = grd; ctx.fillRect(0, 0, c.width, c.height);
    for (const p of pts) {
      const a = reduce ? 0.7 : 0.45 + 0.55 * Math.sin(p.p + t * 0.001 * p.s);
      ctx.fillStyle = p.g ? `rgba(255,226,163,${a})` : `rgba(220,228,255,${a * 0.85})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * devicePixelRatio, 0, 6.283); ctx.fill();
    }
    if (!reduce) requestAnimationFrame(draw);
  };
  addEventListener('resize', resize); resize(); requestAnimationFrame(draw);
})();

const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && e.target.classList.add('in')), { threshold: 0.08 });
document.querySelectorAll('.reveal').forEach((el) => io.observe(el));

await store.init();
await load();
setInterval(load, 5 * 60 * 1000);
