import {
  UNIT_FACTOR, DUTY, OZ_PER_KG, toUnit, spotToInr, gold24From22, ibjaGoldPerG, ibjaSilverPerG,
  silverLanded, markup, pctChange, fmtMytIst, ageMinutes, fmtAge, mcxSession, ibjaWindow,
  ibjaExpectedDate, mjdtaStale, boardLabel, unchangedSince, fmtINR, fmtNum, fmtUSD, dpFor, zoneParts, IST_OFFSET_MIN, MYT_OFFSET_MIN,
  simpleRow, DUTY_SOURCE, G_PER_OZ, leviesOn, taxBreakdown, leviesText,
} from './calc.js';
import { initPredict, predictions, setPredictTaxes, setHolidays, refreshPredict, nextIbjaAt } from './predict.js';

// ------------------------------------------------------------ config
const REPO = 'moulisankar999/gold-silver-fx-dashboard';
const qs = new URLSearchParams(location.search);
const DATA_BASE = qs.get('data') || `https://raw.githubusercontent.com/${REPO}/data/data/`;
const LIVE_EVERY = 30;        // seconds: live spot + FX from gold-api.com
const SCRAPED_EVERY = 120;    // seconds: re-read the scraped JSON written by GitHub Actions
const ER_EVERY = 30 * 60;     // seconds: open.er-api.com daily rates (fallback)
const GOLDAPI = 'https://api.gold-api.com/price/';
const ERAPI = 'https://open.er-api.com/v6/latest/USD';
const STALE = { live: 5, yahoo: 30, daily: 26 * 60, scrapedSpot: 30, mcx: 25, scraper: 40 };

const state = {
  unit: localStorage.getItem('gsfx-unit') || 'g',
  scraped: null, scrapedErr: null, scrapedAt: null,
  history: null,
  live: { xau: null, xag: null, fx: {}, err: null, at: null },
  er: null, erErr: null,
  ticks: loadTicks(),
  nextLive: 0,
  taxes: null,
  holidays: {},
};

// ------------------------------------------------------------ helpers
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const unitLabel = () => ({ g: 'per g', '10g': 'per 10 g', kg: 'per kg' }[state.unit]);
const inr = (v) => fmtINR(v, v == null ? 0 : dpFor(v));
const SRC = (k) => state.scraped?.sources?.[k] || null;
const istDay = () => new Date(Date.now() + IST_OFFSET_MIN * 60000).toISOString().slice(0, 10);
const LEVIES = (metal) => leviesOn(state.taxes, metal, istDay());
const pc = (r) => `${+(r * 100).toFixed(2)}%`;
/** Green banner for a tax change the checker applied (30 days), amber for an unconfirmed one. */
function taxBanner() {
  const t = state.taxes; if (!t) return '';
  const now = Date.now(), out = [];
  const recent = (t.changes || []).filter((c) => now - Date.parse(c.detectedAt) < 30 * 864e5);
  const seen = new Set();
  for (const c of recent.slice().reverse()) {
    const k = `${c.levy}|${c.from}|${c.to}|${c.effective}`; const metals = recent.filter((x) => `${x.levy}|${x.from}|${x.to}|${x.effective}` === k).map((x) => x.metal);
    if (seen.has(k)) continue; seen.add(k);
    const what = c.from == null ? `New levy: ${c.name} (${c.short}) ${pc(c.to)}` : `${c.levy === 'gst' ? 'GST' : c.short === 'BCD' ? 'Import duty (BCD)' : c.name + ' (' + c.short + ')'} changed from ${pc(c.from)} to ${pc(c.to)}`;
    out.push(`<div class="tax-banner ok" role="status"><b>✅ ${esc(what)}</b> on ${esc(metals.join(' & '))}, effective ${esc(fmtDay(c.effective))} <a href="${esc(c.url)}" target="_blank" rel="noopener">(${esc(c.ref || 'source')})</a>. Prices below already use it.</div>`);
  }
  for (const a of (t.alerts || []).filter((a) => a.status === 'open')) {
    out.push(`<div class="tax-banner warn" role="status"><b>⚠️ Possible tax change — checking.</b> ${esc(a.title)} <a href="${esc(a.url)}" target="_blank" rel="noopener">(${a.kind === 'news' ? 'news' : 'official notice'})</a>. Current rates are kept until it is confirmed.</div>`);
  }
  return out.join('');
}
function taxSourceTxt() {
  const g = (state.taxes?.metals?.gold?.levies || []).flatMap((l) => (l.history || []).filter((h) => h.from <= istDay()).slice(-1).map((h) => h.ref)).filter(Boolean);
  return g.length ? [...new Set(g)].join(', ') : DUTY_SOURCE.text;
}
function fmtDay(d) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || ''); return m ? `${+m[3]} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m[2] - 1]} ${m[1]}` : d; }
/** Small per-levy lines under a cell, e.g. "BCD 10% ₹10,866". */
function levyLines(lines, f, group) {
  const ls = lines.filter((l) => (group === 'gst' ? l.group === 'gst' : l.group !== 'gst'));
  if (ls.length < 2 && group === 'gst') return '';
  return `<span class="lv">${ls.map((l) => `<span title="${esc(l.name)}${l.ref ? ' · ' + esc(l.ref) : ''}">${esc(l.short)} ${pc(l.rate)}${l.base === 'duty' ? ' of duty' : ''} ${fmtINR(l.amount * f, dpFor(l.amount * f))}</span>`).join('')}</span>`;
}

async function getJSON(url, timeoutMs = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

function loadTicks() { try { return JSON.parse(localStorage.getItem('gsfx-ticks')) || {}; } catch { return {}; } }
function saveTicks() { try { localStorage.setItem('gsfx-ticks', JSON.stringify(state.ticks)); } catch { /* quota */ } }
function addTick(key, ts, val) {
  if (!(val > 0) || !ts) return;
  const s = (state.ticks[key] ||= []);
  const last = s[s.length - 1];
  if (last && (last[1] === val || last[0] >= ts)) return;
  s.push([ts, val]);
  const cutoff = Date.now() / 1000 - 3 * 86400;
  state.ticks[key] = s.filter((p) => p[0] >= cutoff).slice(-400);
}
function series(key) {
  const h = state.history?.series?.[key] || [];
  const t = state.ticks[key] || [];
  const m = new Map();
  for (const [ts, v] of [...h, ...t]) m.set(ts, v);
  return [...m.entries()].sort((a, b) => a[0] - b[0]);
}
/** Previous distinct value before the latest one, for "vs last" changes. */
function prevDistinct(key, current) {
  const s = series(key);
  for (let i = s.length - 1; i >= 0; i--) if (s[i][1] !== current) return { v: s[i][1], ts: s[i][0] };
  return null;
}

function spark(key, scale = 1) {
  const s = series(key).slice(-80);
  if (s.length < 3) return '';
  const xs = s.map((p) => p[0]), ys = s.map((p) => p[1] * scale);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const W = 200, H = 34, pad = 3;
  const X = (x) => (x1 === x0 ? W / 2 : ((x - x0) / (x1 - x0)) * W);
  const Y = (y) => (y1 === y0 ? H / 2 : H - pad - ((y - y0) / (y1 - y0)) * (H - 2 * pad));
  const d = s.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1] * scale).toFixed(1)}`).join(' ');
  const up = ys[ys.length - 1] >= ys[0];
  const col = up ? 'var(--up)' : 'var(--down)';
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path class="l" d="${d}" stroke="${col}"/></svg>`;
}

function chg(abs, pct, fmt = inr, suffix = '') {
  if (abs == null || !Number.isFinite(abs)) return '';
  const cls = abs > 0 ? 'up' : abs < 0 ? 'down' : 'flat';
  const arrow = abs > 0 ? '▲' : abs < 0 ? '▼' : '■';
  const p = pct != null && Number.isFinite(pct) ? ` (${pct > 0 ? '+' : ''}${pct.toFixed(2)}%)` : '';
  const a = (abs > 0 ? '+' : abs < 0 ? '−' : '') + fmt(Math.abs(abs)).replace('-', '');
  return `<span class="chg ${cls}">${arrow} ${a}${p}${suffix ? ` <span class="muted" style="font-weight:600">${suffix}</span>` : ''}</span>`;
}

function badge(kind, text, title = '') { return `<span class="b ${kind}" title="${esc(title)}">${esc(text)}</span>`; }

function card({ label, value, unit = '', alt = '', change = '', badges = [], foot = '', sparkHtml = '', cls = '' }) {
  return `<article class="card ${cls}">
    <div class="c-top"><div class="c-label">${label}</div><div class="badges">${badges.join('')}</div></div>
    <div class="c-val">${value}${unit ? `<span class="u">${unit}</span>` : ''}</div>
    ${change ? `<div>${change}</div>` : ''}
    ${alt ? `<div class="c-alt">${alt}</div>` : ''}
    ${sparkHtml}
    ${foot ? `<div class="c-foot">${foot}</div>` : ''}
  </article>`;
}

function srcFoot(name, url, iso, extra = '') {
  const age = ageMinutes(iso);
  return `<div>Source: ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(name)}</a>` : esc(name)}</div>
    <div>Updated ${esc(fmtMytIst(iso))}${Number.isFinite(age) ? ` · ${fmtAge(age)}` : ''}</div>${extra ? `<div>${extra}</div>` : ''}`;
}

/** Badges for a source entry: unavailable (last good shown) / stale / live. */
function statusBadges(entry, stale, liveText = null) {
  const b = [];
  if (entry && entry.ok === false) b.push(badge('na', 'Unavailable', `Last fetch failed: ${entry.error || ''}. Showing last good value.`));
  if (stale) b.push(badge('stale', 'Stale', 'Older than expected'));
  if (!b.length && liveText) b.push(badge('live', liveText));
  return b;
}

function sectionHead(kicker, title, right = '') {
  return `<div class="sec-h"><div><div class="kicker">${kicker}</div><h2>${title}</h2></div><div>${right}</div></div>`;
}

// ------------------------------------------------------------ data resolution
function resolveSpot(metal) { // 'xau' | 'xag'
  const c = [];
  const l = state.live[metal];
  if (l) c.push({ usd: l.usd, t: l.t, source: 'gold-api.com (live)', url: `${GOLDAPI}${metal.toUpperCase()}`, kind: 'live' });
  const s = SRC(`spot_${metal}`);
  if (s?.data) c.push({ usd: s.data.usdPerOz, t: s.data.updatedAt, source: 'gold-api.com (via scraper)', url: s.url, kind: 'scrapedSpot', entry: s });
  c.sort((a, b) => new Date(b.t) - new Date(a.t));
  return c[0] || null;
}

const FX_DEF = {
  USDINR: { label: '1 USD', unit: '₹', base: 'USD', quote: 'INR' },
  MYRINR: { label: '1 MYR', unit: '₹', base: 'MYR', quote: 'INR' },
  GBPINR: { label: '1 GBP', unit: '₹', base: 'GBP', quote: 'INR' },
  SGDINR: { label: '1 SGD', unit: '₹', base: 'SGD', quote: 'INR' },
  EURINR: { label: '1 EUR', unit: '₹', base: 'EUR', quote: 'INR' },
  AEDINR: { label: '1 AED', unit: '₹', base: 'AED', quote: 'INR' },
  SGDMYR: { label: '1 SGD', unit: 'RM', base: 'SGD', quote: 'MYR' },
  GBPMYR: { label: '1 GBP', unit: 'RM', base: 'GBP', quote: 'MYR' },
};
function crossFromUsd(rates, base, quote) { // rates: USD->X
  const r = (c) => (c === 'USD' ? 1 : rates?.[c]);
  if (!(r(base) > 0) || !(r(quote) > 0)) return null;
  return r(quote) / r(base);
}
function resolveFx(key) {
  const d = FX_DEF[key], c = [];
  const lf = state.live.fx;
  const lr = crossFromUsd(Object.fromEntries(Object.entries(lf).map(([k, v]) => [k, v.rate])), d.base, d.quote);
  if (lr) {
    const ts = [d.base, d.quote].filter((x) => x !== 'USD').map((x) => lf[x]?.t).filter(Boolean).sort()[0];
    c.push({ rate: lr, t: ts, source: 'gold-api.com (live)', url: 'https://gold-api.com', kind: 'live' });
  }
  const y = SRC(`fx_${key}`);
  if (y?.data) c.push({ rate: y.data.rate, t: y.data.updatedAt, prevClose: y.data.prevClose, source: 'Yahoo Finance (via scraper)', url: `https://finance.yahoo.com/quote/${key}=X`, kind: 'yahoo', entry: y });
  const ers = [];
  const se = SRC('erapi');
  if (se?.data) ers.push({ rates: se.data.usdRates, t: se.data.updatedAt, entry: se, via: 'via scraper' });
  if (state.er) ers.push({ rates: state.er.rates, t: state.er.t, via: 'live' });
  for (const e of ers) {
    const r = crossFromUsd(e.rates, d.base, d.quote);
    if (r) c.push({ rate: r, t: e.t, source: `open.er-api.com (daily, ${e.via})`, url: 'https://open.er-api.com', kind: 'daily', entry: e.entry });
  }
  c.sort((a, b) => new Date(b.t) - new Date(a.t));
  const best = c[0] || null;
  if (best && !best.prevClose && y?.data?.prevClose) best.prevClose = y.data.prevClose;
  return best;
}
const usdInr = () => resolveFx('USDINR');

function chennaiBoard() {
  const m = SRC('mjdta'), w = SRC('cwja');
  const c = [];
  if (m?.data?.values?.g22) c.push({ ...m.data, entry: m, name: 'MJDTA', url: m.url });
  if (w?.data?.values?.g22) c.push({ ...w.data, entry: w, name: 'CWJA (mirror)', url: w.url });
  if (!c.length) return null;
  // MJDTA is the official board; use the CWJA mirror only if MJDTA failed or is clearly older (>30 min).
  c.sort((a, b) => (b.entry.ok - a.entry.ok) || ((new Date(b.updatedAt) - new Date(a.updatedAt)) / 60000 > 30 ? 1 : (new Date(a.updatedAt) - new Date(b.updatedAt)) / 60000 > 30 ? -1 : 0) || (a.name === 'MJDTA' ? -1 : 1));
  return { primary: c[0], all: c };
}

function ibjaLatest() {
  const e = SRC('ibja');
  if (!e?.data) return null;
  const d = e.data;
  const cur = d.pm ? { sess: 'PM', vals: d.pm } : d.am ? { sess: 'AM', vals: d.am } : null;
  let prev = null;
  if (cur?.sess === 'PM' && d.am) prev = { label: `${d.date} AM`, vals: d.am };
  else {
    const pm = d.history?.pm?.[0], am = d.history?.am?.[0];
    if (pm && (!am || pm.date >= am.date)) prev = { label: `${pm.date} PM`, vals: pm };
    else if (am) prev = { label: `${am.date} AM`, vals: am };
  }
  return { entry: e, d, cur, prev };
}

// ------------------------------------------------------------ renderers
function renderStatus() {
  const now = new Date();
  const ms = mcxSession(now), iw = ibjaWindow(now);
  const liveOk = state.live.at && !state.live.err;
  const gen = state.scraped?.generatedAt;
  const scraperLate = ageMinutes(gen) > STALE.scraper;
  const ist = zoneParts(now, IST_OFFSET_MIN);
  const mjdtaNext = ist.minutes < 9 * 60 + 30 ? 'Chennai morning print ~9:30 AM IST' : ist.minutes < 15 * 60 + 30 ? 'Chennai afternoon print ~3:30 PM IST (if any)' : 'Chennai next print ~9:30 AM IST';
  const tb = $('#taxbar'); if (tb) tb.innerHTML = taxBanner();
  $('#statusbar').innerHTML = [
    `<span class="pill"><span class="dot ${liveOk ? 'on' : 'off'}"></span>Live spot/FX ${liveOk ? `· ${fmtMytIst(state.live.at)}` : '· unavailable, using scraped data'}</span>`,
    `<span class="pill"><span class="dot ${!gen ? 'off' : scraperLate ? 'wait' : 'on'}"></span>Scraped data ${gen ? `· ${fmtAge(ageMinutes(gen))}` : `· ${esc(state.scrapedErr || 'loading')}`}</span>`,
    `<span class="pill"><span class="dot ${ms.open ? 'on' : 'off'}"></span>MCX ${esc(ms.label)}</span>`,
    `<span class="pill"><span class="dot ${iw.phase === 'weekend' ? 'off' : 'wait'}"></span>IBJA · ${esc(iw.label)}</span>`,
    `<span class="pill"><span class="dot wait"></span>${mjdtaNext}</span>`,
  ].join('');
}

function renderChennai() {
  const el = $('#chennai');
  const b = chennaiBoard();
  const u = state.unit;
  if (!b) {
    el.innerHTML = sectionHead('Chennai · MJDTA', 'Chennai gold & silver') + `<div class="callout err">Chennai rates unavailable: ${esc(SRC('mjdta')?.error || state.scrapedErr || 'no data yet')}</div>`;
    return;
  }
  const p = b.primary, v = p.values, diff = p.diff || {};
  const stale = mjdtaStale(p.updatedAt);
  const sb = statusBadges(p.entry, stale);
  const foot = srcFoot(p.name === 'MJDTA' ? 'MJDTA board (thejewellersassociation.org)' : 'CWJA board (cwja.org.in)', p.url, p.updatedAt);
  const g24 = gold24From22(v.g22);
  const mk = (key, label, perG, opts = {}) => {
    if (!(perG > 0)) return card({ label, value: '—', badges: [badge('na', 'Not posted')], foot: `${esc(p.name)} has no ${label} figure on the board right now.` });
    const d = diff[key];
    return card({
      label, value: inr(toUnit(perG, u)), unit: unitLabel(), cls: opts.cls || '',
      change: d != null ? chg(toUnit(d, u), d && perG - d ? (d / (perG - d)) * 100 : 0, inr, 'vs prev print') : '',
      alt: opts.alt || '', badges: [...(opts.badges || []), ...sb], foot: opts.foot || foot,
      sparkHtml: opts.spark ? spark(opts.spark, UNIT_FACTOR[u]) : '',
    });
  };
  const cards = [
    mk('g22', '22K gold', v.g22, { cls: 'hero', spark: 'mjdta_g22', alt: `8 g sovereign: ${inr(v.g22 * 8)}` }),
    card({ label: '24K gold', value: g24 ? inr(toUnit(g24, u)) : '—', unit: unitLabel(), badges: [badge('calc', 'Calculated'), ...sb],
      alt: '22K × 24 ÷ 22 (not on the board)', cls: 'hero',
      foot: `Calculated from the ${esc(p.name)} 22K rate, the same way LiveChennai shows 24K. ${srcFoot(p.name, p.url, p.updatedAt)}` }),
    mk('g18', '18K gold', v.g18),
    mk('g14', '14K gold', v.g14),
    mk('silver_g', 'Silver', v.silver_g, { cls: 'silver', spark: 'mjdta_silver_g', alt: `${inr(v.silver_g * 1000)} per kg` }),
  ];
  let cross = '';
  const other = b.all.find((x) => x !== p);
  if (other) {
    const same = other.values.g22 === v.g22 && other.values.silver_g === v.silver_g;
    cross = `<p class="sec-note">${esc(other.name)} cross-check: 22K ₹${fmtNum(other.values.g22, 0)}/g, silver ₹${fmtNum(other.values.silver_g, 0)}/g, updated ${esc(fmtMytIst(other.updatedAt))} — ${same ? 'matches' : '<b>differs from</b>'} the board shown.</p>`;
  }
  el.innerHTML = sectionHead('Chennai · MJDTA', 'Chennai gold & silver', p.updateText ? badge('info', p.updateText) : '') +
    `<div class="grid">${cards.join('')}</div>` +
    `<p class="sec-note">Board rates exclude GST and making charges. MJDTA posts about 9:30 AM IST and, on some days, again about 3:30 PM IST. Change is against MJDTA's previous print.</p>${cross}`;
}

function renderIbja() {
  const el = $('#ibja');
  const L = ibjaLatest();
  const u = state.unit;
  if (!L?.cur) {
    el.innerHTML = sectionHead('IBJA · India benchmark', 'IBJA rates') + `<div class="callout err">IBJA unavailable: ${esc(SRC('ibja')?.error || state.scrapedErr || 'no data yet')}</div>`;
    return;
  }
  const { entry, d, cur, prev } = L;
  const expected = ibjaExpectedDate();
  const stale = d.date && expected && d.date < expected;
  const sb = statusBadges(entry, stale);
  const printTime = (sess) => `${d.date}T${sess === 'PM' ? '17:00' : '12:05'}:00+05:30`;
  const perG = (k, v) => (k.startsWith('s') ? ibjaSilverPerG(v) : ibjaGoldPerG(v));
  const hero = (k, label, cls, sparkKey) => {
    const now = cur.vals[k], before = prev?.vals?.[k];
    const pc = pctChange(now, before);
    const alt = k.startsWith('s') ? `${inr(now)} per kg · ${inr(now / 100)} per 10 g` : `${inr(now)} per 10 g · ${inr(now * 100)} per kg`;
    return card({ label: `${label} · ${cur.sess}`, value: inr(toUnit(perG(k, now), u)), unit: unitLabel(), cls, alt,
      change: pc ? chg(toUnit(perG(k, pc.abs), u), pc.pct, inr, `vs ${prev.label}`) : '',
      badges: sb, sparkHtml: spark(sparkKey, UNIT_FACTOR[u] / (k.startsWith('s') ? 1000 : 10)),
      foot: srcFoot('IBJA (ibjarates.com)', entry.url, printTime(cur.sess), `${cur.sess} print of ${d.date} (nominal ${cur.sess === 'PM' ? '5:00 PM' : '12:05 PM'} IST). Fetched ${esc(fmtMytIst(entry.fetchedAt))}.`) });
  };
  const rows = [['g999', 'Gold 999'], ['g995', 'Gold 995'], ['g916', 'Gold 916 (22K)'], ['g750', 'Gold 750 (18K)'], ['g585', 'Gold 585 (14K)'], ['s999', 'Silver 999']];
  const cell = (k, vals) => (vals?.[k] ? inr(toUnit(perG(k, vals[k]), u)) : '<span class="muted">—</span>');
  const board = (k, vals) => (vals?.[k] ? (k.startsWith('s') ? `${inr(vals[k])}/kg` : `${inr(vals[k])}/10g`) : '—');
  const table = `<div class="tbl"><table class="t"><thead><tr><th>Purity</th><th>AM ${unitLabel()}</th><th>PM ${unitLabel()}</th><th>Board (AM / PM)</th></tr></thead><tbody>
    ${rows.map(([k, n]) => `<tr><td><b>${n}</b></td><td>${cell(k, d.am)}</td><td>${cell(k, d.pm)}</td><td class="muted">${board(k, d.am)} / ${board(k, d.pm)}</td></tr>`).join('')}
  </tbody></table></div>`;
  const iw = ibjaWindow();
  const pmNote = !d.pm && iw.phase === 'pm' && d.date === expected ? ' PM print not out yet.' : '';
  el.innerHTML = sectionHead('IBJA · India benchmark', `IBJA rates · ${d.date || ''}`, `${d.am ? badge('live', 'AM') : ''} ${d.pm ? badge('live', 'PM') : badge('info', 'PM pending')}`) +
    `<div class="grid wide">${hero('g999', 'Gold 999', 'hero', 'ibja_g999')}${hero('s999', 'Silver 999', 'silver', 'ibja_s999')}</div>
     <div style="height:12px"></div>${table}
     <p class="sec-note">IBJA prints about 12:05 PM IST (AM) and 5:00 PM IST (PM), Monday to Friday, none on weekends or IBJA holidays (holidays aren't modelled here, so a holiday can show as stale). Rates exclude 3% GST and making charges.${pmNote}</p>`;
}

function renderMcx() {
  const el = $('#mcx');
  const ms = mcxSession();
  const u = state.unit;
  const todayIst = (() => { const p = zoneParts(new Date(), IST_OFFSET_MIN); return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; })();
  const mk = (metal) => {
    const e = SRC(`mcx_${metal}`);
    const label = metal === 'gold' ? 'MCX Gold' : 'MCX Silver';
    if (!e?.data) return card({ label, value: '—', badges: [badge('fut', 'Futures'), badge('na', 'Unavailable')], foot: `No MCX data: ${esc(e?.error || state.scrapedErr || 'not scraped yet')}` });
    const q = e.data, div = metal === 'gold' ? 10 : 1000;
    const perG = (x) => (x > 0 ? x / div : null);
    const t = q.lastTrade || q.asOf;
    const stale = ms.open && ageMinutes(q.asOf) > STALE.mcx;
    const expired = q.expiry && todayIst > q.expiry;
    const b = [badge('fut', 'Futures'), ...statusBadges(e, stale)];
    if (expired) b.push(badge('na', 'Expired', 'Source still shows an expired contract'));
    const ohl = `O ${inr(toUnit(perG(q.open), u))} · H ${inr(toUnit(perG(q.high), u))} · L ${inr(toUnit(perG(q.low), u))}`;
    return card({ label: `${label} · ${q.contract}`, value: inr(toUnit(perG(q.ltp), u)), unit: unitLabel(), cls: metal === 'gold' ? 'hero' : 'silver',
      change: chg(q.change != null ? toUnit(q.change / div, u) : null, q.changePct, inr, 'vs prev close'), alt: `${ohl}<br>Board: ${inr(q.ltp)} per ${q.unit} · expiry ${q.expiry}`,
      badges: b, sparkHtml: spark(`mcx_${metal}`, UNIT_FACTOR[u] / div),
      foot: srcFoot('mcxlive.org', e.url, t, `Last trade ${esc(fmtMytIst(q.lastTrade))}; page said "Market ${esc(q.marketStatus || '?')}". Scraped every ~10 min, so up to ~15–20 min behind MCX.`) });
  };
  el.innerHTML = sectionHead('MCX · near-month futures', 'MCX futures', badge(ms.open ? 'live' : 'info', ms.open ? 'Market open' : 'Market closed')) +
    `<div class="grid wide">${mk('gold')}${mk('silver')}</div>
     <p class="sec-note">These are <b>futures</b> prices (MCX near-month contract, quoted per 10 g for gold and per kg for silver), not spot or jeweller rates. Session: Mon–Fri 9:00 AM to ${ms.closeLabel} IST (exchange holidays not modelled). The contract rolls to the next one automatically when the source rolls after expiry (5th of the month, or the previous working day). Data is scraped from mcxlive.org by a scheduled job — it is <b>delayed</b>, not tick-by-tick.</p>`;
}

function renderSpot() {
  const el = $('#spot');
  const fx = usdInr();
  const u = state.unit;
  const mk = (metal) => {
    const s = resolveSpot(metal);
    const label = metal === 'xau' ? 'Gold spot' : 'Silver spot';
    if (!s) return card({ label, value: '—', badges: [badge('na', 'Unavailable')], foot: esc(state.live.err || 'No spot source responded') });
    const conv = fx ? spotToInr(s.usd, fx.rate) : null;
    const val = conv ? (u === 'kg' ? conv.perKg : u === '10g' ? conv.per10g : conv.perG) : null;
    const pv = prevDistinct(`spot_${metal}`, s.usd);
    const pc = pv ? pctChange(s.usd, pv.v) : null;
    const stale = ageMinutes(s.t) > (s.kind === 'live' ? STALE.live : STALE.scrapedSpot);
    return card({ label: `${label} · USD/oz → INR`, value: val ? inr(val) : '—', unit: unitLabel(), cls: metal === 'xau' ? 'hero' : 'silver',
      change: pc ? chg(pc.abs, pc.pct, (x) => fmtUSD(x, metal === 'xau' ? 2 : 3), '/oz vs last') : '',
      alt: `${fmtUSD(s.usd, metal === 'xau' ? 2 : 3)} /oz${conv ? ` · ${fmtUSD(conv.usdPerKg, 0)} /kg` : ''}<br>${conv ? `${inr(conv.perG)}/g · ${inr(conv.per10g)}/10g · ${inr(conv.perKg)}/kg` : 'USD/INR unavailable'}`,
      badges: [...statusBadges(s.entry, stale, s.kind === 'live' ? 'Live' : null)], sparkHtml: spark(`spot_${metal}`),
      foot: srcFoot(s.source, s.url, s.t, fx ? `Converted at USD/INR ${fmtNum(fx.rate, 4)} (${esc(fx.source)}, ${esc(fmtMytIst(fx.t))}). Excludes duty and GST.` : '') });
  };
  el.innerHTML = sectionHead('International spot', 'Spot gold & silver') +
    `<div class="grid wide">${mk('xau')}${mk('xag')}</div>
     <p class="sec-note">1 troy oz = 31.1035 g; 1 kg = 32.1507 troy oz. Import parity only: no Indian import duty or GST. Live quotes refresh every ${LIVE_EVERY} s.</p>`;
}

function renderFx() {
  const el = $('#fx');
  const cards = Object.entries(FX_DEF).map(([k, d]) => {
    const r = resolveFx(k);
    if (!r) return card({ label: `${d.label} in ${d.quote}`, value: '—', badges: [badge('na', 'Unavailable')], foot: 'No FX source responded' });
    const stale = ageMinutes(r.t) > STALE[r.kind];
    const pc = r.prevClose ? pctChange(r.rate, r.prevClose) : null;
    const dp = k.endsWith('MYR') ? 4 : 3;
    const fmt = (x) => `${d.unit}${fmtNum(x, dp)}`;
    return card({ label: `${d.label} → ${d.quote}`, value: fmt(r.rate),
      change: pc ? chg(pc.abs, pc.pct, (x) => fmtNum(x, dp), 'vs prev close') : '',
      badges: statusBadges(r.entry, stale, r.kind === 'live' ? 'Live' : null), sparkHtml: spark(`fx_${k}`),
      foot: srcFoot(r.source, r.url, r.t) });
  });
  el.innerHTML = sectionHead('FX', 'Currencies') + `<div class="grid">${cards.join('')}</div>
    <p class="sec-note">Each pair uses the freshest of: gold-api.com live (USD, GBP, SGD, EUR; every ${LIVE_EVERY} s), Yahoo Finance via the scraper (all pairs, ~10 min), open.er-api.com (daily). FX markets close at weekends, so rates can show stale then.</p>`;
}

function renderBreakdown() {
  const el = $('#breakdown');
  const s = resolveSpot('xag'), fx = usdInr();
  const u = state.unit, f = UNIT_FACTOR[u] / 1000; // breakdown computed per kg
  if (!s || !fx) { el.innerHTML = sectionHead('Silver', 'Silver landed-cost breakdown') + `<div class="callout err">Needs both live silver and USD/INR; one is unavailable right now.</div>`; return; }
  const usdKg = s.usd * OZ_PER_KG;
  const baseKg = usdKg * fx.rate;
  const LV = LEVIES('silver');
  const TB = taxBreakdown(baseKg, LV);
  const L = { base: baseKg, duty: TB.duty, dutyPaid: baseKg + TB.duty, gst: TB.gst, landed: TB.final };
  const ib = ibjaLatest();
  const ibKg = ib?.cur?.vals?.s999 || null;
  const ch = chennaiBoard()?.primary;
  const chKg = ch?.values?.silver_g ? ch.values.silver_g * 1000 : null;
  const step = (n, what, how, amt, sub = '', cls = '') => `<div class="step ${cls}"><div class="n">${n}</div><div><div class="what">${what}</div><div class="how">${how}</div></div><div class="amt">${amt}${sub ? `<small>${sub}</small>` : ''}</div></div>`;
  const row = (name, price, when) => {
    const mL = markup(price, L.landed), mD = markup(price, L.dutyPaid);
    if (!mL) return `<tr><td><b>${name}</b></td><td colspan="4" class="muted">unavailable</td></tr>`;
    return `<tr><td><b>${name}</b><div class="muted small">${esc(when)}</div></td><td>${inr(price * f)}</td><td class="${mL.amount >= 0 ? 'up' : 'down'}">${mL.amount >= 0 ? '+' : '−'}${inr(Math.abs(mL.amount * f))}</td><td class="${mL.amount >= 0 ? 'up' : 'down'}">${mL.pct >= 0 ? '+' : ''}${mL.pct.toFixed(2)}%</td><td class="muted">${mD.amount >= 0 ? '+' : '−'}${inr(Math.abs(mD.amount * f))} (${mD.pct >= 0 ? '+' : ''}${mD.pct.toFixed(2)}%)</td></tr>`;
  };
  el.innerHTML = sectionHead('Silver · step by step', `Silver landed cost ${unitLabel()}`) +
    `<div class="steps">
      ${step(1, 'International silver in INR', `${fmtUSD(s.usd, 3)}/oz × 32.1507 oz/kg × USD/INR ${fmtNum(fx.rate, 4)}`, inr(L.base * f), `(${fmtUSD(usdKg * f, 2)})`)}
      ${TB.lines.map((l, i) => step(i + 2, `+ ${esc(l.name)} (${esc(l.short)}) ${pc(l.rate)}`, `${pc(l.rate)} of ${l.base === 'value' ? 'step 1' : l.base === 'duty' ? 'the customs duty above' : 'the running total (duty-paid value)'}${l.ref ? ' · ' + esc(l.ref) : ''}`, inr(l.amount * f), l.group !== 'gst' && TB.lines[i + 1]?.group === 'gst' ? `Duty-paid ${inr(L.dutyPaid * f)} · duty ${pc(TB.dutyPct)}` : '')).join('')}
      ${step('=', 'Landed Indian rate', `Step 1 × ${fmtNum(TB.mult, 4)}`, inr(L.landed * f), `(${fmtUSD(usdKg * TB.mult * f, 2)})`, 'total')}
    </div>
    <div style="height:12px"></div>
    <div class="tbl"><table class="t"><thead><tr><th>Market rate</th><th>Price ${unitLabel()}</th><th>Markup vs landed</th><th>%</th><th>vs duty-paid (ex-GST)</th></tr></thead><tbody>
      ${row(`IBJA Silver 999${ib?.cur ? ` (${ib.cur.sess})` : ''}`, ibKg, ib?.cur ? `${ib.d.date} ${ib.cur.sess} print` : 'unavailable')}
      ${row(`Chennai silver (${ch ? (ch.entry.source.startsWith('MJDTA') ? 'MJDTA' : 'CWJA') : '—'})`, chKg, ch ? `board ${fmtMytIst(ch.updatedAt)}` : 'unavailable')}
    </tbody></table></div>
    <p class="sec-note">Inputs: silver ${esc(s.source)} at ${esc(fmtMytIst(s.t))}; USD/INR ${esc(fx.source)} at ${esc(fmtMytIst(fx.t))}. Taxes from the auto-updated tax file: ${esc(leviesText(LV))} (${esc(taxSourceTxt())}); the customs tariff value and bank charges are ignored. IBJA and Chennai boards exclude GST, so the last column (vs duty-paid, before GST) is the like-for-like premium.</p>`;
}

function renderSources() {
  const el = $('#sources');
  const S = state.scraped?.sources || {};
  const names = { mjdta: 'MJDTA (Chennai)', cwja: 'CWJA (Chennai mirror)', ibja: 'IBJA', mcx_gold: 'MCX Gold (mcxlive.org)', mcx_silver: 'MCX Silver (mcxlive.org)', spot_xau: 'Gold spot (gold-api, scraper)', spot_xag: 'Silver spot (gold-api, scraper)', erapi: 'open.er-api.com (daily FX)' };
  const items = Object.entries(S).map(([k, e]) => {
    const n = names[k] || (k.startsWith('fx_') ? `${k.slice(3)} (Yahoo, scraper)` : k);
    return `<div class="src"><div class="nm"><span>${esc(n)}</span>${e.ok ? badge('live', 'OK') : badge('na', 'Failing')}</div>
      <div class="mt">${e.ok ? `Fetched ${esc(fmtMytIst(e.fetchedAt))}` : `Last attempt ${esc(fmtMytIst(e.lastAttempt))}: ${esc(e.error)}${e.fetchedAt ? `<br>Last good ${esc(fmtMytIst(e.fetchedAt))}` : ''}`}<br><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.url)}</a></div></div>`;
  });
  const liveLine = `<div class="src"><div class="nm"><span>gold-api.com (live, browser)</span>${state.live.err ? badge('na', 'Failing') : state.live.at ? badge('live', 'OK') : badge('info', '…')}</div><div class="mt">${state.live.err ? esc(state.live.err) : `Spot XAU/XAG + USD, GBP, SGD, EUR rates every ${LIVE_EVERY} s`}<br>Last ${esc(fmtMytIst(state.live.at))}</div></div>`;
  el.innerHTML = sectionHead('Transparency', 'Sources & status', state.scraped ? badge('info', `Scraper ran ${fmtAge(ageMinutes(state.scraped.generatedAt))}`) : '') +
    `<div class="src-list">${liveLine}${items.join('')}</div>
     ${state.scrapedErr ? `<div class="callout err">Could not load scraped data: ${esc(state.scrapedErr)}</div>` : ''}
     <p class="sec-note">Scraped sources (Indian rate sites block browser requests) are fetched by a GitHub Actions job every ~10 minutes with extra runs around the print times, and written to the <code>data</code> branch. GitHub can delay scheduled jobs by several minutes.</p>`;
}

function tickerItems() {
  const u = state.unit, it = [];
  const push = (name, val, abs, pct) => it.push({ name, val, abs, pct });
  const b = chennaiBoard()?.primary;
  if (b) { push('Chennai 22K', inr(toUnit(b.values.g22, u)), b.diff?.g22 != null ? toUnit(b.diff.g22, u) : null, b.diff?.g22 ? (b.diff.g22 / (b.values.g22 - b.diff.g22)) * 100 : null);
    push('Chennai Silver', inr(toUnit(b.values.silver_g, u)), b.diff?.silver_g != null ? toUnit(b.diff.silver_g, u) : null, null); }
  const L = ibjaLatest();
  if (L?.cur) { const pc = pctChange(L.cur.vals.g999, L.prev?.vals?.g999); push(`IBJA 999 ${L.cur.sess}`, inr(toUnit(L.cur.vals.g999 / 10, u)), pc ? toUnit(pc.abs / 10, u) : null, pc?.pct);
    const ps = pctChange(L.cur.vals.s999, L.prev?.vals?.s999); push(`IBJA Silver ${L.cur.sess}`, inr(toUnit(L.cur.vals.s999 / 1000, u)), ps ? toUnit(ps.abs / 1000, u) : null, ps?.pct); }
  for (const m of ['gold', 'silver']) { const q = SRC(`mcx_${m}`)?.data; if (q) { const div = m === 'gold' ? 10 : 1000; push(`MCX ${m === 'gold' ? 'Gold' : 'Silver'} Fut`, inr(toUnit(q.ltp / div, u)), toUnit(q.change / div, u), q.changePct); } }
  for (const m of ['xau', 'xag']) { const s = resolveSpot(m); if (s) { const pv = prevDistinct(`spot_${m}`, s.usd); const pc = pv ? pctChange(s.usd, pv.v) : null; push(m === 'xau' ? 'Gold $/oz' : 'Silver $/oz', fmtUSD(s.usd, m === 'xau' ? 2 : 3), pc?.abs, pc?.pct); } }
  for (const k of ['USDINR', 'MYRINR', 'SGDINR', 'GBPINR', 'EURINR', 'AEDINR', 'SGDMYR', 'GBPMYR']) { const r = resolveFx(k); if (r) { const pc = r.prevClose ? pctChange(r.rate, r.prevClose) : null; push(`${k.slice(0, 3)}/${k.slice(3)}`, fmtNum(r.rate, k.endsWith('MYR') ? 4 : 3), pc?.abs, pc?.pct); } }
  return it;
}
function renderTicker() {
  const items = tickerItems();
  if (!items.length) { $('#ticker').innerHTML = '<span class="tk"><b>Loading prices…</b></span>'; return; }
  const html = items.map((x) => {
    const cls = x.abs > 0 ? 'up' : x.abs < 0 ? 'down' : 'flat';
    const ar = x.abs > 0 ? '▲' : x.abs < 0 ? '▼' : '';
    const pct = x.pct != null && Number.isFinite(x.pct) ? `${x.pct > 0 ? '+' : ''}${x.pct.toFixed(2)}%` : '';
    return `<span class="tk"><b>${esc(x.name)}</b><span class="v">${x.val}</span>${ar || pct ? `<span class="${cls}">${ar} ${pct}</span>` : ''}</span>`;
  }).join('');
  const track = $('#ticker');
  track.innerHTML = html + html; // duplicated for a seamless loop
  track.style.animationDuration = `${Math.max(30, items.length * 5)}s`;
}


// ------------------------------------------------------------ Simple view (default landing)
const SIMPLE_UNITS = { gold: localStorage.getItem('gsfx-su-gold') || '10g', silver: localStorage.getItem('gsfx-su-silver') || 'kg' };
const UNIT_TXT = { g: '1 g', '10g': '10 g', kg: '1 kg' };
let memo = (() => { try { return JSON.parse(localStorage.getItem('gsfx-simple-memo')) || {}; } catch { return {}; } })();
/** Remember the last two distinct values of a live number so we can show ▲/▼ vs the previous fetch. */
function remember(key, val, seedPrev = null) {
  if (!(val > 0)) return null;
  const m = memo[key] || {};
  const r = (x) => Math.round(x * 1e4) / 1e4;
  if (m.cur == null) { m.cur = val; m.prev = seedPrev > 0 ? seedPrev : null; }
  else if (r(m.cur) !== r(val)) { m.prev = m.cur; m.cur = val; }
  memo[key] = m;
  return m.prev;
}
function saveMemo() { try { localStorage.setItem('gsfx-simple-memo', JSON.stringify(memo)); } catch { /* ignore */ } }

function arrowOf(delta, eps) {
  if (delta == null || !Number.isFinite(delta) || Math.abs(delta) < eps) return { cls: 'flat', ar: '▬' };
  return delta > 0 ? { cls: 'up', ar: '▲' } : { cls: 'down', ar: '▼' };
}

/** One price cell: ₹ value + arrow + change, and the USD equivalent in brackets. */
function priceCell(val, prev, usdInrRate, opt = {}) {
  if (val == null || !Number.isFinite(val)) return `<div class="pc na"><span class="pv">—</span>${opt.na ? `<span class="pn">${opt.na}</span>` : ''}</div>`;
  const delta = prev != null && Number.isFinite(prev) ? val - prev : null;
  const a = arrowOf(delta, Math.max(0.005, Math.abs(val) * 1e-6));
  const signed = opt.signed && val !== 0 ? (val > 0 ? '+' : '−') : '';
  const v = Math.abs(opt.signed ? val : val);
  const usd = usdInrRate > 0 ? fmtUSD(v / usdInrRate, v / usdInrRate < 100 ? 2 : 0) : null;
  const dtxt = delta != null && a.cls !== 'flat' ? `${delta > 0 ? '+' : '−'}${fmtINR(Math.abs(delta), dpFor(v))}` : 'no change';
  return `<div class="pc ${opt.cls || ''}">
    ${opt.pct != null ? `<span class="pct">${opt.pct}</span>` : ''}
    <span class="pv">${signed}${fmtINR(v, dpFor(v))}${usd ? ` <span class="pu">(${signed}${usd})</span>` : ''}</span>
    <span class="pd ${a.cls}" title="${esc(opt.vsTxt || '')}">${a.ar} ${dtxt}</span>
    ${opt.pn ? `<span class="pn">${esc(opt.pn)}</span>` : ''}
  </div>`;
}

const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtIbjaDate(d) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || ''); return m ? `${+m[3]} ${MON3[+m[2] - 1]}` : (d || ''); }
function simpleMetal(metal) {
  const isGold = metal === 'gold';
  const unit = SIMPLE_UNITS[metal], f = UNIT_FACTOR[unit];
  const sym = isGold ? 'xau' : 'xag';
  const fx = usdInr();
  const fxRate = fx?.rate;
  const s = resolveSpot(sym);
  // International price in INR per gram, with the previous fetch for the arrow.
  let B = null, Bprev = null;
  if (s && fxRate) {
    B = (s.usd / G_PER_OZ) * fxRate;
    const pv = prevDistinct(`spot_${sym}`, s.usd);
    Bprev = remember(`B_${sym}`, B, pv ? (pv.v / G_PER_OZ) * fxRate : null);
  }
  // India = IBJA 999 (ex-GST); Chennai = MJDTA board (ex-GST). Gold uses 24K so purity matches world 999 spot.
  const ib = ibjaLatest();
  const ibCur = ib?.cur?.vals?.[isGold ? 'g999' : 's999'];
  const ibPrev = ib?.prev?.vals?.[isGold ? 'g999' : 's999'];
  const ibPerG = (x) => (x > 0 ? (isGold ? x / 10 : x / 1000) : null);
  const ch = chennaiBoard()?.primary;
  let chCur = null, chPrev = null, ch22 = null;
  if (ch) {
    if (isGold) {
      ch22 = ch.values.g22;
      chCur = gold24From22(ch22);
      const d = ch.diff?.g22; chPrev = d != null ? gold24From22(ch22 - d) : null;
    } else {
      chCur = ch.values.silver_g; const d = ch.diff?.silver_g; chPrev = d != null ? chCur - d : null;
    }
  }
  // Chennai label: always the print DATE, "Today's" vs "Last", whether the value moved, and when the next board is due.
  let chWhen = '—', chWhen2 = '';
  if (ch) {
    const L = boardLabel(ch.updatedAt, new Date(), ch.name === 'MJDTA' ? 'MJDTA board' : 'CWJA board');
    const key = isGold ? 'g22' : 'silver_g', val = ch.values[key], dlt = ch.diff?.[key];
    const since = unchangedSince(state.history?.series?.[`mjdta_${key}`], val);
    const sinceTxt = since ? fmtIbjaDate(new Date(since + IST_OFFSET_MIN * 60000).toISOString().slice(0, 10)) : null;
    const lbl = isGold ? '22K' : 'Silver';
    let moved;
    if (dlt) moved = `${lbl} ${dlt > 0 ? '▲' : '▼'} ₹${fmtNum(Math.abs(dlt), 0)}/g vs previous board`;
    else moved = `${lbl} unchanged at ₹${fmtNum(val, 0)}/g${sinceTxt && sinceTxt !== fmtIbjaDate(ch.updatedAt.slice(0, 10)) ? ` since ${sinceTxt}` : ''}`;
    chWhen = L.text;
    chWhen2 = `${moved} · ${L.next}`;
  }
  const rows = [
    { key: 'world', name: 'World', sub: 'International spot price', flag: '🌍', local: null, localPrev: null,
      when: s ? fmtMytIst(s.t) : '—', src: s ? s.source : 'spot unavailable', vsTxt: 'vs previous update' },
    { key: 'india', name: 'India', sub: 'IBJA national benchmark (999)', flag: '🇮🇳', local: ibPerG(ibCur), localPrev: ibPerG(ibPrev),
      when2: state.holidays[istDay()] ? `Today is an IBJA holiday (${state.holidays[istDay()]}), so no new rates today` : '',
      when: ib?.cur ? `${fmtIbjaDate(ib.d.date)} ${ib.cur.sess} print (${ib.cur.sess === 'PM' ? '5:00 PM' : '12:05 PM'} IST)` : '—', src: 'IBJA (ibjarates.com)', vsTxt: ib?.prev ? `vs ${ib.prev.label} print` : 'vs previous' },
    { key: 'chennai', name: 'Chennai', sub: isGold ? `MJDTA board · 24K (22K ₹${ch22 ? fmtNum(ch22, 0) : '—'}/g)` : 'MJDTA board', flag: '🏙️', local: chCur, localPrev: chPrev,
      when: chWhen, when2: chWhen2, src: ch ? ch.name : 'Chennai unavailable', vsTxt: 'vs previous board print' },
  ];
  const LV = LEVIES(metal);
  const TB = taxBreakdown(100, LV);
  const dutyTxt = pc(TB.dutyPct), gstTxt = pc(TB.gstRate);
  const fmtRow = (r) => {
    const cur = B ? simpleRow(B, r.local, LV) : null;
    const prv = (Bprev || B) ? simpleRow(Bprev || B, r.local == null ? null : (r.localPrev ?? r.local), LV) : null;
    const P = (k) => (cur?.[k] != null ? cur[k] * f : null);
    const Q = (k) => (prv?.[k] != null ? prv[k] * f : null);
    const naLocal = r.local == null && r.key !== 'world' ? 'not posted' : null;
    const notApp = '<div class="pc na"><span class="pv">—</span><span class="pn">not applicable</span></div>';
    const intl = priceCell(B ? B * f : null, Bprev ? Bprev * f : null, fxRate, { vsTxt: 'vs previous update' });
    let duty, gst, fin;
    if (r.key === 'world') {
      duty = notApp; gst = notApp;
      fin = priceCell(P('final'), Q('final'), fxRate, { cls: 'final', vsTxt: r.vsTxt });
    } else if (!cur) {
      const why = !B ? 'needs world price' : naLocal || 'unavailable';
      const bb = B ? taxBreakdown(B, LV) : null, bp = Bprev ? taxBreakdown(Bprev, LV) : null;
      duty = priceCell(bb ? bb.duty * f : null, null, fxRate, { na: why, pct: dutyTxt });
      gst = priceCell(bb ? bb.gst * f : null, null, fxRate, { na: why, pct: gstTxt });
      fin = priceCell(bb ? bb.final * f : null, bp ? bp.final * f : null, fxRate, { cls: 'final total', pn: `world + ${dutyTxt} duty + ${gstTxt} GST`, vsTxt: 'vs previous update' })
        + `<div class="mg na"><div class="mg-l">Dealer margin (market rate)</div><span class="pn">${esc(why)}</span></div>`;
    } else {
      const mkt = r.key === 'india' ? 'IBJA' : 'MJDTA';
      duty = priceCell(P('duty'), Q('duty'), fxRate, { pct: dutyTxt, vsTxt: 'moves with the world price' }).replace(/<\/div>\s*$/, `${levyLines(cur.lines, f, 'duty')}</div>`);
      gst = priceCell(P('gst'), Q('gst'), fxRate, { pct: gstTxt, pn: 'on world + duty', vsTxt: 'moves with the world price' }).replace(/<\/div>\s*$/, `${levyLines(cur.lines, f, 'gst')}</div>`);
      const m = cur.marginPct;
      const margin = priceCell(P('margin'), Q('margin'), fxRate, { signed: true, cls: `mgv ${cur.margin >= 0 ? 'prem' : 'disc'}`,
        pct: `${m >= 0 ? "+" : "−"}${Math.abs(m).toFixed(Math.abs(m) < 1 ? 2 : 1)}%`, vsTxt: `${mkt} price incl. GST minus total` });
      const market = priceCell(P('market'), Q('market'), fxRate, { cls: 'mkt', vsTxt: r.vsTxt });
      const exG = (cur.intl + cur.duty) * f;
      fin = priceCell(P('final'), Q('final'), fxRate, { cls: 'final total', pn: `world + ${dutyTxt} duty + ${gstTxt} GST · no dealer margin`, vsTxt: 'moves with the world price' })
        + `<div class="nogst">Without GST <b>${fmtINR(exG, dpFor(exG))}</b> <span class="pu">(${fmtUSD(exG / fxRate, exG / fxRate < 100 ? 2 : 0)})</span></div>`
        + `<div class="mg"><div class="mg-l">Dealer margin <span>(market rate)</span> · ${mkt}</div>${margin}`
        + `<div class="mg-l mk">Market price (${mkt}, incl. GST)</div>${market}<div class="nogst sm">without GST ${fmtINR(cur.local * f, dpFor(cur.local * f))} (${mkt} board)</div></div>`;
    }
    return `<tr class="row-${r.key}">
      <th scope="row" class="where"><span class="fl" aria-hidden="true">${r.flag}</span><div><b>${r.name}</b><small>${esc(r.sub)}</small><small class="when">${esc(r.when)}</small>${r.when2 ? `<small class="when2">${esc(r.when2)}</small>` : ''}</div></th>
      <td data-l="International rate">${intl}</td>
      <td data-l="Import duty">${duty}</td>
      <td data-l="GST">${gst}</td>
      <td data-l="${r.key === 'world' ? 'Final (no Indian tax)' : 'Total price (incl. duty & GST)'}" class="fcol">${fin}</td>
    </tr>`;
  };
  const seg = `<div class="seg sm" role="radiogroup" aria-label="${isGold ? 'Gold' : 'Silver'} unit">${['g', '10g', 'kg'].map((u) => `<button role="radio" data-metal="${metal}" data-su="${u}" aria-checked="${u === unit}">${UNIT_TXT[u]}</button>`).join('')}</div>`;
  const spotTxt = s ? `${fmtUSD(s.usd, isGold ? 2 : 3)}/oz × ₹${fmtNum(fxRate, 2)} per $` : 'spot unavailable';
  return `<section class="sv-card ${metal}">
    <div class="sv-h">
      <div><div class="kicker">${isGold ? 'Gold · 24K / 999' : 'Silver · 999'}</div><h2>${isGold ? '🟡 Gold' : '⚪ Silver'} price, ${UNIT_TXT[unit]}</h2><p class="sv-sub">World price ${esc(spotTxt)}</p></div>
      ${seg}
    </div>
    <div class="sv-tbl"><table class="sv">
      <thead><tr><th>Where</th><th>International rate<small>world price in ₹</small></th><th>Import duty<small>${esc(LV.filter((l) => l.group !== 'gst').map((l) => l.short).join(' + '))} · tax to bring metal in</small></th><th>GST<small>${gstTxt} of world + duty</small></th><th class="fcol-h">Total price (incl. duty &amp; GST)<small>no dealer margin · dealer margin (market rate) below</small></th></tr></thead>
      <tbody>${rows.map(fmtRow).join('')}</tbody>
    </table></div>
  </section>`;
}

function simpleFx() {
  const pairs = [['GBPINR', '🇬🇧 GBP → 🇮🇳 INR', '₹'], ['USDINR', '🇺🇸 USD → 🇮🇳 INR', '₹'], ['MYRINR', '🇲🇾 MYR → 🇮🇳 INR', '₹'], ['GBPMYR', '🇬🇧 GBP → 🇲🇾 MYR', 'RM ']];
  const tiles = pairs.map(([k, label, cur]) => {
    const r = resolveFx(k);
    if (!r) return `<div class="fx-tile"><div class="fx-l">${label}</div><div class="fx-v">—</div><div class="pd flat">unavailable</div></div>`;
    let prevClose = r.prevClose;
    if (!prevClose && k === 'GBPMYR') { const a = SRC('fx_GBPINR')?.data, b = SRC('fx_MYRINR')?.data; if (a?.prevClose && b?.prevClose) prevClose = a.prevClose / b.prevClose; }
    const dp = k.endsWith('MYR') ? 4 : 2;
    const mPrev = remember(`fx_${k}`, r.rate);
    const ref = prevClose || mPrev;
    const delta = ref ? r.rate - ref : null;
    const a = arrowOf(delta, Math.pow(10, -dp - 1));
    const pct = ref ? ` (${delta >= 0 ? '+' : ''}${((delta / ref) * 100).toFixed(2)}%)` : '';
    return `<div class="fx-tile">
      <div class="fx-l">${label}</div>
      <div class="fx-v">${cur}${fmtNum(r.rate, dp)}</div>
      <div class="pd ${a.cls}">${a.ar} ${delta != null && a.cls !== 'flat' ? `${delta > 0 ? '+' : '−'}${fmtNum(Math.abs(delta), dp)}${pct}` : 'no change'}</div>
      <div class="fx-s">${prevClose ? 'vs yesterday’s close' : 'vs previous update'} · ${esc(r.source.replace(/ \(.*\)/, ''))} · ${esc(fmtMytIst(r.t))}</div>
    </div>`;
  });
  return `<section class="sv-fx"><div class="sv-h"><div><div class="kicker">Currencies</div><h2>💱 Exchange rates</h2><p class="sv-sub">How much 1 unit of the first currency buys</p></div></div><div class="fx-grid">${tiles.join('')}</div></section>`;
}

function renderSimple() {
  const el = $('#simple');
  if (!el) return;
  const live = state.live.at && !state.live.err;
  el.innerHTML = `
    <div class="sv-hero">
      <div><h2>What gold & silver cost today</h2><p>From the world price, add India’s taxes, and see what it costs in India and Chennai.</p></div>
      <span class="pill"><span class="dot ${live ? 'on' : 'wait'}"></span>${live ? `Live · ${esc(fmtMytIst(state.live.at))}` : 'Loading live prices…'}</span>
    </div>
    ${taxBanner()}
    <div class="sv-explain">
      <div><b>International rate</b> = world price, changed into rupees</div>
      <div><b>Import duty (${pc(taxBreakdown(100, LEVIES('gold')).dutyPct)})</b> = tax India charges to bring metal in: ${esc(LEVIES('gold').filter((l) => l.group !== 'gst').map((l) => `${l.short} ${pc(l.rate)}`).join(' + '))}</div>
      <div><b>GST (${pc(taxBreakdown(100, LEVIES('gold')).gstRate)})</b> = sales tax on (world + duty)</div>
      <div><b>Total price</b> = world + duty + GST, with no dealer margin</div>
      <div><b>Dealer margin (market rate)</b> = market price (IBJA / MJDTA, incl. GST) minus the total: what dealers add (+) or knock off (−)</div>
    </div>
    ${simpleMetal('gold')}
    ${simpleMetal('silver')}
    ${predictTable()}
    ${simpleFx()}
    <p class="sv-note">▲ up · ▼ down · ▬ no change. World price arrows compare with the previous update; India and Chennai compare with the previous board print. Dollar figures in brackets use today’s USD/INR. Taxes in force today: gold ${esc(leviesText(LEVIES('gold')))}; silver ${esc(leviesText(LEVIES('silver')))} (${esc(taxSourceTxt())}). Checked automatically against CBIC Customs and GST notifications${state.taxes?.checkedAt ? `, last check ${esc(fmtMytIst(state.taxes.checkedAt))}` : ''}; any new levy appears as its own line. Chennai 24K is worked out from the 22K board (× 24 ÷ 22). Boards and IBJA exclude GST, so the market price adds 3% GST to the board rate before the dealer margin is worked out.</p>`;
  el.querySelectorAll('[data-su]').forEach((b) => b.addEventListener('click', () => {
    SIMPLE_UNITS[b.dataset.metal] = b.dataset.su; localStorage.setItem(`gsfx-su-${b.dataset.metal}`, b.dataset.su); renderSimple();
  }));
  saveMemo();
}

// ------------------------------------------------------------ Today (live) vs Tomorrow (predicted)
const DOW3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function istYmd(ms) { return new Date(ms + IST_OFFSET_MIN * 60000).toISOString().slice(0, 10); }
/** Next MJDTA morning board (~9:30 AM IST, Mon-Sat). */
function nextMjdta(now = Date.now()) {
  for (let k = 0; k < 8; k++) {
    const d = new Date(now + IST_OFFSET_MIN * 60000 + k * 864e5);
    if (d.getUTCDay() === 0) continue;
    const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 9, 30) - IST_OFFSET_MIN * 60000;
    if (t > now) return t;
  }
  return null;
}
function whenWord(t) {
  if (!t) return { head: 'Next print (predicted)', sub: '' };
  const day = istYmd(t), today = istYmd(Date.now()), tom = istYmd(Date.now() + 864e5);
  const d = new Date(t + IST_OFFSET_MIN * 60000);
  const hm = `${((d.getUTCHours() + 11) % 12) + 1}:${String(d.getUTCMinutes()).padStart(2, '0')} ${d.getUTCHours() < 12 ? 'AM' : 'PM'} IST`;
  const dd = `${DOW3[d.getUTCDay()]} ${d.getUTCDate()} ${MON3[d.getUTCMonth()]}`;
  return { head: day === today ? 'Later today (predicted)' : day === tom ? 'Tomorrow (predicted)' : `${DOW3[d.getUTCDay()]} (predicted)`, sub: `${dd}, ${hm}`, day };
}
function moveWords(pred, today, dp, unitTxt) {
  if (!(pred > 0) || !(today > 0)) return { cls: 'flat', ar: '▬', txt: '' };
  const d = pred - today, rel = Math.abs(d) / today;
  if (rel < 0.0008) return { cls: 'flat', ar: '▬', txt: 'likely about the same' };
  return { cls: d > 0 ? 'up' : 'down', ar: d > 0 ? '▲' : '▼', txt: `likely ${d > 0 ? 'up' : 'down'} ${fmtINR(Math.abs(d), dp)}` };
}
function predictModel() {
  const R = predictions();
  if (!R) return null;
  const { P } = R;
  const s = resolveSpot('xau'), a = resolveSpot('xag'), fx = usdInr();
  const wg = s && fx ? (s.usd / G_PER_OZ) * fx.rate * 10 : null;   // world 24K per 10 g
  const ws = a && fx ? a.usd * OZ_PER_KG * fx.rate : null;         // world silver per kg
  const gstR = taxBreakdown(100, LEVIES('gold')).gstRate;
  const ch = (p, mult) => (p && p.p ? { p: p.p * mult, lo: p.lo * mult, hi: p.hi * mult, last: p.last ? p.last.value * mult : null, lastWhen: p.last, bt: p.bt } : null);
  const naiveBetter = (p) => p?.bt?.naive && p?.bt?.M && p.bt.naive.mape < p.bt.M.mape;
  const rows = [
    { key: 'g24', name: 'Gold 24K', unit: 'per 10 g', dp: 0, world: wg, india: ch(P.ibja_g, 1), chennai: ch(P.ch_g24, 10), chNaive: naiveBetter(P.ch_g22) },
    { key: 'g22', name: 'Gold 22K', unit: 'per 10 g', dp: 0, world: wg ? (wg * 22) / 24 : null, india: P.ibja_g22 ? { ...ch(P.ibja_g22, 1), last: P.ibja_g22.last?.value, lastWhen: P.ibja_g22.last } : null, chennai: ch(P.ch_g22, 10), chNaive: naiveBetter(P.ch_g22) },
    { key: 'ag', name: 'Silver', unit: 'per kg', dp: 0, world: ws, india: ch(P.ibja_s, 1), chennai: ch(P.ch_s, 1000), chNaive: naiveBetter(P.ch_s), inNaive: naiveBetter(P.ibja_s) },
  ];
  return { R, rows, gstR, ib: whenWord(R.nextIbja), mj: whenWord(nextMjdta()), fx };
}
function predictTable(opts = {}) {
  const M = predictModel();
  if (!M) return `<section class="pt-card"><div class="sv-h"><div><div class="kicker">Today vs tomorrow</div><h2>🔮 Predicted rates</h2></div></div><p class="skeleton">Loading predictions…</p></section>`;
  const { rows, gstR, ib, mj } = M;
  const g = (v) => (v > 0 ? `<small class="gst">incl. GST ${fmtINR(v * (1 + gstR), 0)}</small>` : '');
  const today = (v, when, dp, gst = true) => (v > 0 ? `<div class="pt-v">${fmtINR(v, dp)}</div>${gst ? g(v) : ''}${when ? `<small class="pt-w">${esc(when)}</small>` : ''}` : '<div class="pt-v na">—</div>');
  const tomorrow = (p, todayV, dp, naive) => {
    if (!p || !(p.p > 0)) return '<div class="pt-v na">—</div><small class="pt-w">not enough data yet</small>';
    if (naive && todayV > 0) {
      return `<div class="pt-v">${fmtINR(todayV, dp)}</div><span class="pd flat">▬ likely no change</span><small class="pt-w">board moves rarely · model ${fmtINR(p.p, dp)}</small>`;
    }
    const w = moveWords(p.p, todayV, dp);
    return `<div class="pt-v pred">${fmtINR(p.p, dp)}</div><span class="pd ${w.cls}">${w.ar} ${esc(w.txt)}</span>${g(p.p)}<small class="pt-w">range ${fmtINR(p.lo, dp)} – ${fmtINR(p.hi, dp)}</small>`;
  };
  const lw = (l) => (l ? `${fmtIbjaDate(l.date)} ${l.sess === 'Morning' ? 'AM' : l.sess === 'Evening' ? 'PM' : l.sess || ''}`.trim() : '');
  const body = rows.map((r) => `<tr class="pt-${r.key}">
      <th scope="row"><b>${r.name}</b><small>${r.unit}</small></th>
      <td class="pt-world" data-l="🌍 World · today (live)">${today(r.world, 'spot, no Indian tax', r.dp, false)}</td>
      <td class="pt-world pt-t" data-l="🌍 World · tomorrow">${r.world ? '<div class="pt-v na">Not forecast</div><small class="pt-w">moves with global markets; the India and Chennai forecasts assume it stays near today’s level</small>' : '—'}</td>
      <td data-l="🇮🇳 India (IBJA) · today">${today(r.india?.last, `last print ${lw(r.india?.lastWhen)}`, r.dp)}</td>
      <td class="pt-t" data-l="🇮🇳 India · ${esc(ib.head)}">${tomorrow(r.india, r.india?.last, r.dp, r.inNaive)}</td>
      <td data-l="🏙️ Chennai (MJDTA) · today">${today(r.chennai?.last, `board ${lw(r.chennai?.lastWhen)}${r.key === 'g24' ? ' · from 22K' : ''}`, r.dp)}</td>
      <td class="pt-t" data-l="🏙️ Chennai · ${esc(mj.head)}">${tomorrow(r.chennai, r.chennai?.last, r.dp, r.chNaive)}</td>
    </tr>`).join('');
  const bt = M.R.bt || {};
  const acc = (k) => (bt[k]?.M ? `${(bt[k].M.mape * 100).toFixed(1)}%` : '—');
  return `<section class="pt-card ${opts.big ? 'big' : ''}">
    <div class="sv-h"><div><div class="kicker">Today (live) vs ${esc(ib.head.replace(' (predicted)', '').toLowerCase())} (predicted)</div><h2>🔮 Gold &amp; silver: today and next board</h2>
      <p class="sv-sub">Board prices before GST (GST-inclusive shown under each). Next India print: <b>${esc(ib.sub)}</b> · next Chennai board: <b>${esc(mj.sub)}</b>.</p></div></div>
    <div class="pt-tbl"><table class="pt">
      <thead>
        <tr class="grp"><th rowspan="2">Metal</th><th colspan="2">🌍 World</th><th colspan="2">🇮🇳 India · IBJA</th><th colspan="2">🏙️ Chennai · MJDTA</th></tr>
        <tr><th>Today<small>live</small></th><th class="pt-t">Tomorrow<small>not forecast</small></th><th>Today<small>latest print</small></th><th class="pt-t">${esc(ib.head.replace(' (predicted)', ''))}<small>predicted · ${esc(ib.sub)}</small></th><th>Today<small>latest board</small></th><th class="pt-t">${esc(mj.head.replace(' (predicted)', ''))}<small>predicted · ${esc(mj.sub)}</small></th></tr>
      </thead>
      <tbody>${body}</tbody>
    </table></div>
    <p class="sv-note">How it works: today’s COMEX and MCX prices and the rupee, plus how far each board has recently sat from them, give the next board rate. Range = how far off it has been lately (80% of the time inside). Typical miss: 24K India ${acc('ibja_g')}, silver India ${acc('ibja_s')}, 22K Chennai ${acc('ch_g22')}, silver Chennai ${acc('ch_s')}. ${M.R.manual ? '<b>Using your own input values (Prediction → Detailed).</b> ' : ''}Estimate only, not financial advice.</p>
  </section>`;
}
function renderPsimple() {
  const el = $('#psimple'); if (!el) return;
  el.innerHTML = `<div class="sv-hero"><div><h2>What will gold &amp; silver cost next?</h2><p>Today’s live rates next to the predicted next board rate, for India (IBJA) and Chennai (MJDTA).</p></div>
    <span class="pill"><span class="dot ${predictions() ? 'on' : 'wait'}"></span>${predictions() ? `Model data · ${esc(fmtMytIst(predictions().generatedAt))}` : 'Loading…'}</span></div>
    ${taxBanner()}${predictTable({ big: true })}`;
}

// Tab switch: "Live rates" (the dashboard) and "Prediction" (the predictor), each with Simple / Detailed.
function setTab(t, push = true) {
  const tab = t === 'predict' ? 'predict' : 'live';
  document.body.dataset.tab = tab;
  try { localStorage.setItem('gsfx-tab', tab); } catch { /* ignore */ }
  document.querySelectorAll('#tabSeg button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  if (push) history.replaceState(null, '', tab === 'predict' ? '#predict' : document.body.dataset.view === 'detailed' ? '#detailed' : location.pathname + location.search);
  if (tab === 'predict') renderPsimple();
  window.scrollTo({ top: 0 });
}

// View switch: Simple is the default landing view; "Detailed" is the original dashboard.
function setView(v, push = true) {
  const view = v === 'detailed' ? 'detailed' : 'simple';
  document.body.dataset.view = view;
  try { sessionStorage.setItem('gsfx-view', view); } catch { /* ignore */ }
  document.querySelectorAll('#viewSeg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.view === view)));
  if (push) history.replaceState(null, '', document.body.dataset.tab === 'predict' ? '#predict' : view === 'detailed' ? '#detailed' : location.pathname + location.search);
  window.scrollTo({ top: 0 });
}

function renderAll() {
  const sections = [renderSimple, renderStatus, renderChennai, renderIbja, renderMcx, renderSpot, renderFx, renderBreakdown, renderSources, renderTicker];
  for (const fn of sections) {
    try { fn(); } catch (e) { console.warn('render failed', fn.name, e); }
  }
  document.querySelectorAll('#unitSeg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.unit === state.unit)));
}

// ------------------------------------------------------------ fetching
async function loadScraped() {
  try {
    const [latest, hist] = await Promise.all([
      getJSON(`${DATA_BASE}latest.json?t=${Date.now()}`),
      getJSON(`${DATA_BASE}history.json?t=${Date.now()}`).catch(() => null),
    ]);
    state.scraped = latest; state.scrapedErr = null; state.scrapedAt = new Date().toISOString();
    loadTaxes();
    if (hist) state.history = hist;
    try { localStorage.setItem('gsfx-scraped', JSON.stringify(latest)); } catch { /* ignore */ }
  } catch (e) {
    state.scrapedErr = `${e.name === 'AbortError' ? 'timeout' : e.message}`;
    if (!state.scraped) { try { state.scraped = JSON.parse(localStorage.getItem('gsfx-scraped')); } catch { /* ignore */ } }
  }
}

function feedPredictTaxes() {
  const at = (metal, iso) => taxBreakdown(100, leviesOn(state.taxes, metal, new Date((iso ? Date.parse(iso) : Date.now()) + IST_OFFSET_MIN * 60000).toISOString().slice(0, 10)));
  const g = at('gold');
  setPredictTaxes({ duty: g.dutyPct, gst: g.gstRate, dutyAt: (metal, iso) => at(metal, iso).dutyPct });
}
async function loadHolidays() {
  try { const h = await getJSON(`config/ibja-holidays.json?t=${Math.floor(Date.now() / 36e5)}`); state.holidays = h.days || {}; setHolidays(Object.keys(state.holidays)); } catch { /* ignore */ }
}
async function loadTaxes() {
  try { state.taxes = await getJSON(`${DATA_BASE}taxes.json?t=${Date.now()}`); }
  catch { try { state.taxes = state.taxes || await getJSON(`config/taxes.json?t=${Date.now()}`); } catch { /* defaults */ } }
  feedPredictTaxes();
  try { renderSimple(); renderBreakdown(); renderStatus(); } catch { /* ignore */ }
}

async function loadLive() {
  const syms = [['xau', 'XAU'], ['xag', 'XAG']];
  const fxs = ['INR', 'GBP', 'SGD', 'EUR'];
  const res = await Promise.allSettled([
    ...syms.map(([, s]) => getJSON(`${GOLDAPI}${s}`, 9000)),
    ...fxs.map((c) => getJSON(`${GOLDAPI}XAU/${c}`, 9000)),
  ]);
  const errs = [];
  syms.forEach(([k], i) => {
    const r = res[i];
    if (r.status === 'fulfilled' && r.value?.price > 0) {
      state.live[k] = { usd: r.value.price, t: r.value.updatedAt };
      addTick(`spot_${k}`, Math.floor(new Date(r.value.updatedAt).getTime() / 1000), r.value.price);
    } else errs.push(`${k.toUpperCase()}: ${r.reason?.message || 'bad response'}`);
  });
  fxs.forEach((c, j) => {
    const r = res[syms.length + j];
    if (r.status === 'fulfilled' && r.value?.exchangeRate > 0 && r.value.currency === c) state.live.fx[c] = { rate: r.value.exchangeRate, t: r.value.updatedAt };
    else errs.push(`${c}: ${r.reason?.message || 'bad response'}`);
  });
  state.live.err = errs.length ? `gold-api.com: ${errs.join(', ')}` : null;
  if (errs.length < syms.length + fxs.length) state.live.at = new Date().toISOString();
  for (const k of Object.keys(FX_DEF)) { const r = resolveFx(k); if (r?.kind === 'live') addTick(`fx_${k}`, Math.floor(new Date(r.t).getTime() / 1000), r.rate); }
  saveTicks();
}

async function loadEr() {
  try { const j = await getJSON(ERAPI); if (j.result === 'success') { state.er = { rates: j.rates, t: new Date(j.time_last_update_unix * 1000).toISOString() }; state.erErr = null; } }
  catch (e) { state.erErr = e.message; }
}

let busy = false, lastScraped = 0, lastEr = 0;
async function refresh(force = false) {
  if (busy) return;
  busy = true; $('#refreshBtn').classList.add('busy');
  const now = Date.now();
  const jobs = [loadLive()];
  if (force || now - lastScraped > SCRAPED_EVERY * 1000) { jobs.push(loadScraped()); lastScraped = now; }
  if (force || now - lastEr > ER_EVERY * 1000) { jobs.push(loadEr()); lastEr = now; }
  await Promise.allSettled(jobs);
  renderAll();
  state.nextLive = Date.now() + LIVE_EVERY * 1000;
  busy = false; $('#refreshBtn').classList.remove('busy');
}

function clock() {
  const now = new Date();
  const m = zoneParts(now, MYT_OFFSET_MIN);
  const p2 = (n) => String(n).padStart(2, '0');
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  $('#clock').textContent = `${days[m.dow]} ${m.d}/${m.mo} · ${fmtMytIst(now.toISOString(), now)}`;
  const left = Math.max(0, Math.round((state.nextLive - Date.now()) / 1000));
  $('#countdown').textContent = busy ? '…' : `${p2(Math.floor(left / 60))}:${p2(left % 60)}`;
  if (!busy && state.nextLive && Date.now() >= state.nextLive && document.visibilityState === 'visible') refresh();
}

// ------------------------------------------------------------ boot
document.querySelectorAll('#viewSeg button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
document.querySelectorAll('#tabSeg button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
setTab(location.hash === '#predict' ? 'predict' : location.hash === '#detailed' || location.hash === '#live' ? 'live' : (localStorage.getItem('gsfx-tab') || 'live'), false);
setView(location.hash === '#detailed' ? 'detailed' : (sessionStorage.getItem('gsfx-view') || 'simple'), false);
document.querySelectorAll('#unitSeg button').forEach((b) => b.addEventListener('click', () => {
  state.unit = b.dataset.unit; localStorage.setItem('gsfx-unit', state.unit); renderAll();
}));
$('#themeBtn').addEventListener('click', () => {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t; localStorage.setItem('gsfx-theme', t);
  document.querySelector('meta[name=theme-color]').setAttribute('content', t === 'dark' ? '#0b0f17' : '#f3f5fa');
});
$('#refreshBtn').addEventListener('click', () => { refresh(true); refreshPredict(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() >= state.nextLive) refresh(); });
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

try { state.scraped = JSON.parse(localStorage.getItem('gsfx-scraped')); } catch { /* ignore */ }
renderAll();
refresh(true);
loadHolidays().finally(() => initPredict({ holidays: Object.keys(state.holidays), onChange: () => { try { renderSimple(); renderPsimple(); } catch (e) { console.warn(e); } } }));
setInterval(clock, 1000);
clock();
