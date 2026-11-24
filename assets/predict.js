// Prediction tab (merged from india-gold-rate-predictor). Renders into #pdetail; exposes predictions for the
// simple "today vs tomorrow" table. Data: data branch predict/latest.json (falls back to the old repo's feed).
import * as C from './predict-calc.js';

const REPO = 'moulisankar999/gold-silver-fx-dashboard';
const qs = new URLSearchParams(location.search);
const DATA_BASE = qs.get('data') || `https://raw.githubusercontent.com/${REPO}/data/data/`;
const DATA_URLS = [qs.get('pdata') || `${DATA_BASE}predict/latest.json`, 'https://raw.githubusercontent.com/moulisankar999/india-gold-rate-predictor/data/data/latest.json'];
const GOLDAPI = 'https://api.gold-api.com/price/';
const DATA_EVERY = 120;
const LIVE_EVERY = 60;
const OVR_KEY = 'igp-ovr';
let onChange = () => {};
let holidays = [];

const INPUTS = [
  { k: 'cg', src: 'comex_gold', name: 'COMEX gold', sub: 'Front-month futures', unit: 'USD/oz', dp: 1, metal: 'gold' },
  { k: 'cs', src: 'comex_silver', name: 'COMEX silver', sub: 'Front-month futures', unit: 'USD/oz', dp: 3, metal: 'silver' },
  { k: 'fx', src: 'usdinr', name: 'USD / INR', sub: 'Rupees per dollar', unit: '₹ per $', dp: 3 },
  { k: 'mg', src: 'mcx_gold', name: 'MCX gold', sub: 'Near-month futures', unit: '₹/10 g', dp: 0, metal: 'gold' },
  { k: 'ms', src: 'mcx_silver', name: 'MCX silver', sub: 'Near-month futures', unit: '₹/kg', dp: 0, metal: 'silver' },
];
const STALE_MIN = { cg: 30, cs: 30, fx: 60, mg: 30, ms: 30 };

const state = { data: null, err: null, ovr: loadOvr(), live: {}, bt: {}, loadedAt: 0, nextData: 0 };

// ---------------------------------------------------------------- formatting
const nf = (dp) => new Intl.NumberFormat('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const inr = (v, dp = 0) => (v == null || !Number.isFinite(v) ? '—' : '₹' + nf(dp).format(v));
const num = (v, dp = 2) => (v == null || !Number.isFinite(v) ? '—' : nf(dp).format(v));
const usd = (v, dp = 2) => (v == null || !Number.isFinite(v) ? '—' : '$' + new Intl.NumberFormat('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }).format(v));
const pct = (v, dp = 2, sign = true) => (v == null || !Number.isFinite(v) ? '—' : (sign && v > 0 ? '+' : '') + (v * 100).toFixed(dp) + '%');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pctTxt = (r) => `${+(r * 100).toFixed(2)}%`;
const $ = (id) => document.getElementById('p-' + id) || { set innerHTML(v) {}, classList: { add() {}, remove() {} }, querySelectorAll: () => [], addEventListener() {} };
function arrow(now, before, fmt, { eps } = {}) {
  const d = C.dir(now, before, eps);
  if (d == null) return '<span class="chg flat">—</span>';
  const diff = now - before, cls = d > 0 ? 'up' : d < 0 ? 'down' : 'flat', sym = d > 0 ? '▲' : d < 0 ? '▼' : '▬';
  return `<span class="chg ${cls}">${sym} ${fmt(Math.abs(diff))} (${pct(now / before - 1)})</span>`;
}
const sessTxt = (r) => (r ? `${new Date(r.date + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}${r.sess ? ' ' + (r.sess === 'Morning' ? 'AM' : r.sess === 'Evening' ? 'PM' : r.sess) : ''}` : '—');

// ---------------------------------------------------------------- overrides
function loadOvr() { try { return JSON.parse(localStorage.getItem(OVR_KEY) || '{}'); } catch { return {}; } }
function saveOvr() { try { localStorage.setItem(OVR_KEY, JSON.stringify(state.ovr)); } catch {} }

function currentInputs() {
  const I = state.data?.inputs || {};
  const x = {};
  for (const d of INPUTS) x[d.k] = state.ovr[d.k] != null ? state.ovr[d.k] : I[d.src]?.value ?? null;
  x.mgExp = I.mcx_gold?.expiry; x.msExp = I.mcx_silver?.expiry;
  return x;
}

// ---------------------------------------------------------------- compute
function compute() {
  const rows = state.data?.rows || [];
  const x = currentInputs();
  const at = new Date().toISOString();
  const P = {};
  for (const k of Object.keys(C.TARGETS)) {
    state.bt[k] = state.bt[k] || C.backtest(rows, k);
    P[k] = C.predict(rows, k, x, at, state.bt[k]);
  }
  const r916 = C.ratio916(rows);
  const g24 = P.ibja_g;
  P.ibja_g22 = g24.p ? { p: g24.p * r916, lo: g24.lo * r916, hi: g24.hi * r916, last: lastPrint(rows, 'ibja', 'g916'), ratio: r916 } : null;
  const ch = P.ch_g22;
  P.ch_g24 = ch.p ? { p: ch.p * 24 / 22, lo: ch.lo * 24 / 22, hi: ch.hi * 24 / 22, last: ch.last ? { ...ch.last, value: ch.last.value * 24 / 22 } : null } : null;
  return { P, x };
}
function lastPrint(rows, board, key) {
  const r = rows.filter((z) => z.k === board && z.a[key] > 0);
  const l = r[r.length - 1];
  return l ? { value: l.a[key], date: l.date, sess: l.sess, t: l.t } : null;
}

// ---------------------------------------------------------------- render: hero
function heroCard({ cls, name, sub, p, perUnit, unitLbl, last, lastLbl, gUnitDiv }) {
  if (!p || !p.p) return `<article class="ppc ${cls}"><div class="ppc-name">${name}</div><p class="note">Not enough data yet.</p></article>`;
  const perG = p.p / gUnitDiv, big = p.p;
  const lastV = last?.value;
  return `<article class="ppc ${cls}">
    <div class="ppc-top"><div class="ppc-name">${name}<small>${sub}</small></div><span class="tag live">Predicted</span></div>
    <div class="big">${inr(perG)}<span class="u">/ 1 g</span></div>
    <div class="mid">${inr(big)}<span class="u">/ ${unitLbl}</span></div>
    <div class="gstrow">
      <div class="gst"><b>With ${pctTxt(C.GST)} GST</b><span>${inr(C.withGst(perG))} <i>/ 1 g</i></span></div>
      <div class="gst"><b>With ${pctTxt(C.GST)} GST</b><span>${inr(C.withGst(big))} <i>/ ${unitLbl}</i></span></div>
    </div>
    <div class="range">Likely range (80%): <b>${inr(p.lo)} – ${inr(p.hi)}</b> / ${unitLbl}</div>
    <div class="cmp"><span>${lastLbl} <b>${sessTxt(last)}</b>: ${inr(lastV)}</span>${lastV ? arrow(big, lastV, (v) => inr(v)) : ''}</div>
  </article>`;
}

function renderHero(P) {
  const nx = nextIbja(Date.now());
  $('hero').innerHTML = `
    <div class="hero-head">
      <div><span class="kick">Predicted India rate · if IBJA priced it now</span><h2>Gold 24K · 22K · Silver</h2></div>
      <div class="meta">Before making charges · Next IBJA print ~${esc(C.fmtMytIst(nx))}</div>
    </div>
    <div class="cards">
      ${heroCard({ cls: 'g24', name: '24K gold (999)', sub: 'India benchmark (IBJA)', p: P.ibja_g, unitLbl: '10 g', gUnitDiv: 10, last: P.ibja_g.last, lastLbl: 'Last IBJA' })}
      ${heroCard({ cls: '', name: '22K gold (916)', sub: 'Jewellery gold (IBJA 916)', p: P.ibja_g22, unitLbl: '10 g', gUnitDiv: 10, last: P.ibja_g22?.last, lastLbl: 'Last IBJA' })}
      ${heroCard({ cls: 'ag', name: 'Silver (999)', sub: 'India benchmark (IBJA)', p: P.ibja_s, unitLbl: '1 kg', gUnitDiv: 1000, last: P.ibja_s.last, lastLbl: 'Last IBJA' })}
    </div>
    <p class="note">▲/▼ = predicted rate against the last actual IBJA print. Board prices exclude ${pctTxt(C.GST)} GST; the GST boxes add it. Range = how far off the model has been on recent prints.</p>`;
}

function renderChennai(P) {
  const row = (name, sub, p, dp, unit) => {
    if (!p || !p.p) return `<tr><td><b>${name}</b><small>${sub}</small></td><td colspan="4">Not enough data yet</td></tr>`;
    const l = p.last;
    return `<tr><td><b>${name}</b><small>${sub}</small></td>
      <td class="hl"><b>${inr(p.p, dp)}</b><small>+GST ${inr(C.withGst(p.p), dp)}</small></td>
      <td class="mob-hide">${inr(p.lo, dp)} – ${inr(p.hi, dp)}<small>80% range</small></td>
      <td>${inr(l?.value, dp)}<small>${esc(sessTxt(l))}</small><small class="mob-only">${l ? arrow(p.p, l.value, (v) => inr(v, dp)) : ''}</small></td>
      <td class="mob-hide">${l ? arrow(p.p, l.value, (v) => inr(v, dp)) : '—'}</td></tr>`;
  };
  $('chennai').innerHTML = `
    <div class="h2"><div><span class="kick">Chennai board (MJDTA)</span><h2>Chennai prediction</h2></div></div>
    <div class="tw"><table>
      <thead><tr><th>Metal</th><th>Predicted</th><th class="mob-hide">Range</th><th>Last print</th><th class="mob-hide">vs last</th></tr></thead>
      <tbody>
        ${row('22K gold', 'per 1 g', P.ch_g22, 0, '/ 1 g')}
        ${row('24K gold', 'per 1 g · 22K × 24 ÷ 22', P.ch_g24, 0, '/ 1 g')}
        ${row('Silver', 'per 1 g', P.ch_s, 1, '/ 1 g')}
      </tbody></table></div>
    <p class="note">MJDTA posts about 9:30 AM IST (sometimes again about 3:30 PM IST), Monday to Saturday. The Chennai silver board moves in ₹5 steps and lags world moves, so its prediction is the least reliable (see accuracy below). Chennai 24K is not posted by MJDTA; it is worked out from 22K.</p>`;
}

// ---------------------------------------------------------------- render: inputs
function inputCard(d) {
  const I = state.data?.inputs?.[d.src] || {};
  const man = state.ovr[d.k] != null;
  const v = man ? state.ovr[d.k] : I.value;
  const ageMin = I.t ? (Date.now() - Date.parse(I.t)) / 60000 : Infinity;
  const closed = (d.k === 'mg' || d.k === 'ms') ? I.status === 'Close' : !marketOpen(d.k);
  const tag = man ? '<span class="tag man">Manual</span>' : !I.ok ? '<span class="tag err">Source down</span>'
    : closed ? '<span class="tag">Closed</span>' : ageMin > STALE_MIN[d.k] ? '<span class="tag stale">Delayed</span>' : '<span class="tag live">Live</span>';
  const prev = I.prevClose;
  const fmt = d.k === 'cg' || d.k === 'cs' ? (z) => usd(z, d.dp) : d.k === 'fx' ? (z) => num(z, 3) : (z) => inr(z);
  let extra = '';
  if (d.k === 'cg' || d.k === 'cs') {
    const L = state.live[d.k === 'cg' ? 'XAU' : 'XAG'];
    if (L) extra = `<br>Spot now ${usd(L.price, d.dp)} · gold-api.com · ${esc(C.ageText(L.t))}`;
  }
  if ((d.k === 'mg' || d.k === 'ms') && I.expiry) extra = `<br>Contract expiry ${esc(I.expiry)}`;
  return `<div class="in ${man ? 'man' : ''}" data-k="${d.k}">
    <div class="in-top"><b>${d.name}</b>${tag}</div>
    <div class="in-row"><input inputmode="decimal" autocomplete="off" aria-label="${d.name} (${d.unit})" data-k="${d.k}" value="${v != null ? (d.dp ? (+v).toFixed(d.dp) : Math.round(v)) : ''}"><span class="unit">${d.unit}</span></div>
    <span class="chg">${man ? `Live: ${fmt(I.value)} <button class="reset" data-reset="${d.k}">Use live</button>` : prev ? arrow(v, prev, fmt) + ' <span class="flat">vs prev close</span>' : ''}</span>
    <div class="src">${d.sub} · <a href="${esc(I.url || '#')}" target="_blank" rel="noopener">${esc(I.source || '—')}</a><br>${esc(C.fmtMytIst(I.t))} · ${esc(C.ageText(I.t))}${I.ok === false && I.error ? `<br>Last error: ${esc(I.error).slice(0, 80)}` : ''}${extra}</div>
  </div>`;
}
function renderInputs() {
  $('inputs').innerHTML = `
    <div class="h2"><div><span class="kick">Inputs · filled in automatically</span><h2>Live COMEX, MCX and rupee</h2></div>
      <button class="btn" id="p-resetAll" ${Object.keys(state.ovr).length ? '' : 'hidden'}>Reset all to live</button></div>
    <div class="ins">${INPUTS.map(inputCard).join('')}</div>
    <p class="note">Tap any number to try your own value ("what if gold hits $3,600?"); everything updates instantly. COMEX and USD/INR: Yahoo Finance, refreshed about every 10 minutes. MCX: mcxlive.org (unofficial, delayed about 15–20 minutes). ▲/▼ compare with the previous close.</p>`;
  $('inputs').querySelectorAll('input[data-k]').forEach((el) => {
    el.addEventListener('change', () => {
      const v = parseFloat(el.value.replace(/[,₹$\s]/g, ''));
      if (Number.isFinite(v) && v > 0) state.ovr[el.dataset.k] = v; else delete state.ovr[el.dataset.k];
      saveOvr(); render();
    });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.blur(); });
  });
  $('inputs').querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', () => { delete state.ovr[b.dataset.reset]; saveOvr(); render(); }));
  const ra = $('resetAll'); if (ra) ra.addEventListener('click', () => { state.ovr = {}; saveOvr(); render(); });
}

// ---------------------------------------------------------------- render: methods
function renderMethods(P) {
  const L = [
    ['ibja_g', '24K gold · IBJA', '10 g', 0], ['ibja_s', 'Silver · IBJA', '1 kg', 0],
    ['ch_g22', '22K gold · Chennai', '1 g', 0], ['ch_s', 'Silver · Chennai', '1 g', 1],
  ];
  const card = ([k, name, unit, dp]) => {
    const p = P[k];
    const line = (tag, label, raw, rawTxt, off, offTxt, est, w) => `<div class="mrow">
        <span class="mtag">${tag}</span>
        <div class="mtxt"><b>${label}</b><small>${inr(raw, dp)} ${rawTxt} · ${pct(off)} ${offTxt}</small></div>
        <div class="mval"><b>${inr(est, dp)}</b><small>weight ${Math.round(w * 100)}%</small></div></div>`;
    return `<div class="mcard"><div class="mhead"><b>${name}</b><span>per ${unit}</span></div>
      ${line('A', 'COMEX landed cost', p.A.raw, `world + ${pctTxt(C.DUTY)} duty`, p.A.cal?.offset, 'premium', p.A.p, p.A.w)}
      ${line('B', 'MCX based', p.B.raw, 'MCX spot-adjusted', p.B.cal?.offset, 'offset', p.B.p, p.B.w)}
      <div class="mrow tot"><span class="mtag">=</span><div class="mtxt"><b>Blended prediction</b><small>80% range ± ${pct(p.band, 2, false)}</small></div><div class="mval"><b>${inr(p.p, dp)}</b></div></div>
    </div>`;
  };
  $('methods').innerHTML = `
    <div class="h2"><div><span class="kick">Two methods, side by side</span><h2>How each estimate is built</h2></div></div>
    <div class="mgrid">${L.map(card).join('')}</div>
    <p class="note">Premium / offset = the average gap between each method and the real board price over the last ${C.CAL_N.ibja} IBJA prints (last ${C.CAL_N.chennai} for Chennai), newest weighted most. 22K = 24K × ${num(P.ibja_g22?.ratio, 4)} (IBJA's 916 ratio). Weights favour whichever method has been closer on the last ${C.W_WINDOW} prints.</p>`;
}

// ---------------------------------------------------------------- render: accuracy
function lineChart(bt, title, dp) {
  const rows = bt.rows.filter((r) => r.pM);
  if (rows.length < 3) return '';
  const W = 520, H = 170, pl = 8, pr = 8, pt = 10, pb = 22;
  const vals = rows.flatMap((r) => [r.actual, r.pM]);
  const lo = Math.min(...vals), hi = Math.max(...vals), pad = (hi - lo) * 0.08 || hi * 0.001;
  const X = (i) => pl + (i / (rows.length - 1)) * (W - pl - pr);
  const Y = (v) => pt + (1 - (v - (lo - pad)) / (hi - lo + 2 * pad)) * (H - pt - pb);
  const path = (k) => rows.map((r, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(r[k]).toFixed(1)}`).join(' ');
  const lbl = [0, Math.floor((rows.length - 1) / 2), rows.length - 1].map((i) => `<text x="${X(i)}" y="${H - 6}" font-size="11" fill="currentColor" opacity=".6" text-anchor="${i === 0 ? 'start' : i === rows.length - 1 ? 'end' : 'middle'}">${esc(sessTxt(rows[i]))}</text>`).join('');
  return `<div class="chart"><h3>${title}</h3>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}: predicted against actual">
      <path d="${path('actual')}" fill="none" stroke="var(--info)" stroke-width="2.5" stroke-linejoin="round"/>
      <path d="${path('pM')}" fill="none" stroke="var(--gold)" stroke-width="2.5" stroke-dasharray="6 4" stroke-linejoin="round"/>
      ${rows.map((r, i) => `<circle cx="${X(i)}" cy="${Y(r.actual)}" r="2.6" fill="var(--info)"><title>${esc(sessTxt(r))}: actual ${inr(r.actual, dp)}, predicted ${inr(r.pM, dp)}</title></circle>`).join('')}
      ${lbl}</svg>
    <div class="legend"><span><i style="background:var(--info)"></i>Actual print</span><span><i style="background:var(--gold)"></i>Predicted beforehand</span></div>
    <div class="score">
      <div><b>Avg miss</b><span>${pct(bt.M?.mape, 2, false)}</span></div>
      <div><b>A · COMEX</b><span>${pct(bt.A?.mape, 2, false)}</span></div>
      <div><b>B · MCX</b><span>${pct(bt.B?.mape, 2, false)}</span></div>
      <div><b>Naive</b><span>${pct(bt.naive?.mape, 2, false)}</span></div>
    </div></div>`;
}
function renderAccuracy(P) {
  const t = (k, name, unit, dp, div = 1) => {
    const bt = state.bt[k];
    const last = bt.rows[bt.rows.length - 1];
    const avgRs = bt.M && last ? bt.M.mape * last.actual / div : null;
    return `<tr><td><b>${name}</b><small>${unit}</small></td>
      <td class="hl"><b>${pct(bt.M?.mape, 2, false)}</b><small>≈ ${inr(avgRs, dp)}</small></td>
      <td class="mob-hide">${pct(bt.A?.mape, 2, false)}</td><td class="mob-hide">${pct(bt.B?.mape, 2, false)}</td>
      <td>${pct(bt.naive?.mape, 2, false)}<small>reuse last print</small></td>
      <td class="mob-hide">${pct(bt.M?.bias)}<small>${bt.M?.n || 0} prints</small></td></tr>`;
  };
  const ib = state.bt.ibja_g;
  const mcxRecon = ib.rows.filter((r) => r.mcxHow === 'recon').length;
  $('accuracy').innerHTML = `
    <div class="h2"><div><span class="kick">Backtest · tested on past prints</span><h2>How accurate has it been?</h2></div></div>
    <div class="acc">${lineChart(state.bt.ibja_g, '24K gold · IBJA ₹/10 g', 0)}${lineChart(state.bt.ibja_s, 'Silver · IBJA ₹/kg', 0)}</div>
    <div class="tw" style="margin-top:12px"><table>
      <thead><tr><th>Rate</th><th>Avg miss</th><th class="mob-hide">A · COMEX</th><th class="mob-hide">B · MCX</th><th>Naive</th><th class="mob-hide">Bias</th></tr></thead>
      <tbody>${t('ibja_g', '24K gold · IBJA', 'per 10 g', 0)}${t('ibja_s', 'Silver · IBJA', 'per kg', 0)}${t('ch_g22', '22K gold · Chennai', 'per 1 g', 0)}${t('ch_s', 'Silver · Chennai', 'per 1 g', 1)}</tbody>
    </table></div>
    <p class="note">Walk-forward test: each past print was predicted using only the prints before it, with COMEX, MCX and USD/INR as they were at that print time (IBJA AM ≈ 12:00 PM IST, PM ≈ 5:00 PM IST; Chennai ≈ 9:40 AM IST). "Naive" is simply reusing the previous print, the bar the model has to beat. Bias below 0 = the model has been predicting too low. ${mcxRecon ? `For ${mcxRecon} of the last ${ib.rows.length} IBJA prints the MCX price at print time was rebuilt from MCX's previous close plus the COMEX × rupee move (real 5-minute MCX data builds up from now on).` : ''} Chennai history is only ${state.bt.ch_g22.M?.n || 0} prints so far and grows daily.</p>`;
}

function renderHow(P, x) {
  const g = P.ibja_g;
  $('how').innerHTML = `
    <div class="h2"><div><span class="kick">In plain English</span><h2>How the prediction works</h2></div></div>
    <div class="how">
      <ol>
        <li><b>World price in rupees.</b> COMEX gold ${usd(x.cg, 1)} per ounce × ${num(x.fx, 2)} rupees per dollar ÷ 31.1035 grams per ounce = <b>${inr(x.cg * x.fx / C.G_PER_OZ)}</b> per gram.</li>
        <li><b>Add import duty.</b> India charges ${pctTxt(C.DUTY)} customs duty to bring gold and silver in (from the auto-updated tax file), so ×${(1 + C.DUTY).toFixed(3).replace(/0+$/, '')} gives the landed cost: <b>${inr(g.A.raw)}</b> per 10 g.</li>
        <li><b>Add the local premium (method A).</b> Dealers in India sell above or below landed cost depending on demand. Recently the gap has been <b>${pct(g.A.cal?.offset)}</b>, so A says <b>${inr(g.A.p)}</b>.</li>
        <li><b>Cross-check with MCX (method B).</b> MCX is India's own gold futures market, already in rupees and duty-paid. After taking out the small cost of holding a future until it expires, and the usual gap to IBJA (<b>${pct(g.B.cal?.offset)}</b>), B says <b>${inr(g.B.p)}</b>.</li>
        <li><b>Blend.</b> The two are mixed, trusting whichever has been more accurate lately: <b>${inr(g.p)}</b> per 10 g for 24K. 22K is 91.6% of that, and silver follows the same steps per kg.</li>
        <li><b>GST.</b> Board rates exclude GST; you pay ${pctTxt(C.GST)} on top when you buy (plus the jeweller's making charges, not included here).</li>
      </ol>
      <p class="note">Formula: <code>A = COMEX × USD/INR ÷ 31.1035 × ${(1 + C.DUTY).toFixed(3).replace(/0+$/, '')} × (1 + premium)</code> · <code>B = MCX ÷ (1 + 6.5% × days-to-expiry/365) × (1 + offset)</code> · <code>Predicted = wA·A + wB·B</code>. Duty and GST come from the same auto-updated tax file as the Live tab.</p>
    </div>`;
}

function renderFoot() {
  const D = state.data;
  const st = D?.status || {};
  const names = { comex_gold: 'COMEX gold', comex_silver: 'COMEX silver', usdinr: 'USD/INR', mcx_gold: 'MCX gold', mcx_silver: 'MCX silver', ibja: 'IBJA board', ibja_pdf: 'IBJA 30-day', mjdta: 'MJDTA Chennai', gr_gold: 'Chennai gold history', gr_silver: 'Chennai silver history', spot_xau: 'Spot gold', spot_xag: 'Spot silver' };
  const pills = Object.entries(names).filter(([k]) => st[k]).map(([k, n]) => `<span title="${esc(st[k].source || '')}${st[k].error ? ' · ' + esc(st[k].error) : ''}"><i class="dot ${st[k].ok ? 'on' : 'off'}"></i>${n}</span>`).join('');
  const age = D ? (Date.now() - Date.parse(D.generatedAt)) / 60000 : null;
  const ib = D?.prints?.ibja?.slice(-1)[0], ch = D?.prints?.chennai?.slice(-1)[0];
  $('foot').innerHTML = `
    <div class="disc">Estimate only, not financial advice.</div>
    <div>Data updated ${D ? `${esc(C.fmtMytIst(D.generatedAt))} (${esc(C.ageText(D.generatedAt))})` : '—'}${age != null && age > 45 ? ' <span class="tag stale">Update delayed</span>' : ''} · checks about every 10 minutes, 7 AM to midnight IST, Monday to Saturday.</div>
    <div class="st">${pills}</div>
    <div>Actual prints used for calibration: IBJA (<a href="https://ibjarates.com/" target="_blank" rel="noopener">ibjarates.com</a>, latest ${esc(sessTxt(ib))}), Chennai MJDTA (<a href="https://www.thejewellersassociation.org/" target="_blank" rel="noopener">thejewellersassociation.org</a>, latest ${esc(sessTxt(ch))}) with past days from goodreturns.in. COMEX and USD/INR from Yahoo Finance; MCX from mcxlive.org (unofficial, delayed); spot check from gold-api.com. Times are shown in MYT with IST alongside. Rates exclude making charges.</div>`;
}

// ---------------------------------------------------------------- banner, clock, schedule helpers
function renderBanner() {
  const parts = [];
  if (state.err && !state.data) parts.push(`<div class="banner warn"><span>Couldn't load prices: ${esc(state.err)}. Retrying…</span></div>`);
  else if (state.err) parts.push(`<div class="banner warn"><span>Last refresh failed (${esc(state.err)}); showing the previous data.</span></div>`);
  const n = Object.keys(state.ovr).length;
  if (n) parts.push(`<div class="banner"><span>You're using ${n} manual value${n > 1 ? 's' : ''}. Predictions use your numbers.</span><button id="p-bannerReset">Use live prices</button></div>`);
  $('banner').innerHTML = parts.join('');
  const b = $('bannerReset'); if (b) b.addEventListener('click', () => { state.ovr = {}; saveOvr(); render(); });
}
function istParts(ms) {
  const d = new Date(ms + 330 * 60000);
  return { dow: d.getUTCDay(), h: d.getUTCHours(), m: d.getUTCMinutes(), y: d.getUTCFullYear(), mo: d.getUTCMonth(), day: d.getUTCDate() };
}
function nextIbja(now) {
  for (let k = 0; k < 8; k++) {
    const p = istParts(now + k * 86400000);
    if (p.dow === 0 || p.dow === 6) continue;
    if (holidays.includes(`${p.y}-${String(p.mo + 1).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`)) continue;
    for (const [hh, mm] of [[12, 5], [17, 0]]) {
      const t = Date.UTC(p.y, p.mo, p.day, hh, mm) - 330 * 60000;
      if (t > now) return t;
    }
  }
  return null;
}
function marketOpen(k) {
  // COMEX: Sun 6 PM to Fri 5 PM New York (closed daily 5-6 PM). Approximated in UTC (EST): Sun 23:00 to Fri 22:00.
  const d = new Date(), dow = d.getUTCDay(), h = d.getUTCHours();
  if (dow === 6) return false;
  if (dow === 0) return h >= 23;
  if (dow === 5) return h < 22;
  return h !== 22;
}

// ---------------------------------------------------------------- data
async function getJson(url, ms = 15000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}
async function loadData() {
  try {
    let d = null, lastErr = null;
    for (const u of DATA_URLS) {
      try { d = await getJson(u + (u.includes('?') ? '&' : '?') + 't=' + Date.now()); if (d?.inputs && Array.isArray(d.rows)) { state.src = u; break; } } catch (e) { lastErr = e; }
    }
    if (!d) throw lastErr || new Error('no data');
    if (!d?.inputs || !Array.isArray(d.rows)) throw new Error('unexpected data');
    if (!state.data || d.generatedAt !== state.data.generatedAt) { state.data = d; state.bt = {}; }
    state.err = null;
  } catch (e) { state.err = e.name === 'AbortError' ? 'timed out' : e.message; }
  state.nextData = Date.now() + DATA_EVERY * 1000;
  render();
  onChange();
}
async function loadLive() {
  for (const s of ['XAU', 'XAG']) {
    try { const j = await getJson(GOLDAPI + s, 10000); if (j?.price > 0) state.live[s] = { price: +j.price, t: j.updatedAt }; } catch {}
  }
  if (state.data && !document.activeElement?.matches?.('#p-inputs input')) renderInputs();
}

function render() {
  renderBanner();
  renderFoot();
  if (!state.data) return;
  const { P, x } = compute();
  renderHero(P);
  renderChennai(P);
  if (!document.activeElement?.matches?.('#p-inputs input')) renderInputs();
  renderMethods(P);
  renderAccuracy(P);
  renderHow(P, x);
}

// ---------------------------------------------------------------- public API
export function initPredict(opts = {}) {
  onChange = opts.onChange || onChange;
  holidays = opts.holidays || [];
  if (opts.taxes) C.setTaxes(opts.taxes);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() > state.nextData - 30000) { loadData(); loadLive(); } });
  setInterval(() => { if (!document.hidden && Date.now() >= state.nextData) loadData(); }, 5000);
  setInterval(() => { if (!document.hidden) loadLive(); }, LIVE_EVERY * 1000);
  loadData(); loadLive();
}
export function setPredictTaxes(t) { C.setTaxes(t); state.bt = {}; if (state.data) { render(); onChange(); } }
export function setHolidays(h) { holidays = h || []; }
export function refreshPredict() { loadData(); loadLive(); }
export function renderPredict() { render(); }
export function predictions() {
  if (!state.data) return null;
  const { P, x } = compute();
  return { P, x, data: state.data, nextIbja: nextIbja(Date.now()), generatedAt: state.data.generatedAt, manual: Object.keys(state.ovr).length, bt: state.bt };
}
export const nextIbjaAt = (ms) => nextIbja(ms);
