// Pure maths for the India gold & silver rate predictor. No DOM. Unit-tested in tests/calc.test.mjs.
export const G_PER_OZ = 31.1035;   // grams per troy ounce
export const OZ_PER_KG = 32.1507;  // troy ounces per kilogram
// Gold (HS 7108) and silver (HS 7106): BCD 10% + AIDC 5% = 15% customs duty since 13 May 2026
// (Customs Notifications 15/2026 & 16/2026). GST 3% on top. A cut to 6% is talked about but not notified.
// Defaults only: the merged app feeds the live levies from taxes.json through setTaxes().
export let DUTY = 0.15;
export let GST = 0.03;
let dutyFn = null;   // (metal, isoTime) -> total customs duty rate in force then
export function setTaxes({ duty, gst, dutyAt } = {}) {
  if (duty > 0) DUTY = duty;
  if (gst > 0) GST = gst;
  dutyFn = typeof dutyAt === 'function' ? dutyAt : null;
}
export const dutyAt = (metal, at) => (dutyFn ? dutyFn(metal, at) ?? DUTY : DUTY);
export const DUTY_SOURCE = {
  text: 'Customs duty 15% (BCD 10% + AIDC 5%) on gold and silver since 13 May 2026; GST 3% on top.',
  url: 'https://www.business-standard.com/economy/news/india-hikes-import-duty-on-gold-and-silver-to-15-platinum-to-15-4-126051300762_1.html',
};
export const CARRY = 0.065;        // yearly cost of carry used to pull MCX futures back to a spot-equivalent
export const CAL_N = { ibja: 10, chennai: 6 };   // calibration window: last N prints (IBJA AM+PM ≈ 5 trading days)
export const MIN_PRIOR = 4;
export const HALF_LIFE = 1.5;    // calibration half-life in prints
export const W_WINDOW = 10;     // blend weights from the last 10 backtest errors        // a backtest prediction needs at least this many earlier prints
export const Z80 = 1.2816;         // 80% two-sided range

/** COMEX USD/oz -> INR per 10 g of 999 gold, duty paid, before GST. */
export function parityGold10g(usdOz, usdInr, duty) {
  duty = duty ?? DUTY;
  if (!(usdOz > 0) || !(usdInr > 0)) return null;
  return (usdOz * usdInr / G_PER_OZ) * 10 * (1 + duty);
}
/** COMEX USD/oz -> INR per kg of 999 silver, duty paid, before GST. */
export function paritySilverKg(usdOz, usdInr, duty) {
  duty = duty ?? DUTY;
  if (!(usdOz > 0) || !(usdInr > 0)) return null;
  return usdOz * OZ_PER_KG * usdInr * (1 + duty);
}

/** Approximate MCX near-month expiry for a date when the feed did not say (5th of the next contract month). */
export function nearExpiry(metal, isoDate) {
  const months = metal === 'gold' ? [2, 4, 6, 8, 10, 12] : [3, 5, 7, 9, 12];
  const d = new Date(isoDate.slice(0, 10) + 'T00:00:00Z');
  let y = d.getUTCFullYear();
  for (let k = 0; k < 24; k++) {
    for (const m of months) {
      const e = new Date(Date.UTC(y, m - 1, 5));
      if (e > d) return e.toISOString().slice(0, 10);
    }
    y++;
  }
  return null;
}

/** MCX futures -> spot-equivalent: take out the carry for the days left to expiry. */
export function mcxSpotAdj(mcx, expiryIso, atMs) {
  if (!(mcx > 0)) return null;
  if (!expiryIso) return mcx;
  const days = Math.max(0, (Date.parse(expiryIso + 'T17:30:00Z') - atMs) / 86400000);
  return mcx / (1 + CARRY * days / 365);
}

// Each target: which actual print it predicts, and the two raw model values from the inputs.
// Raw values are in the target's own unit; calibration (a ratio) absorbs purity, premium and basis.
export const TARGETS = {
  ibja_g: { board: 'ibja', metal: 'gold', unit: '10g', actual: (a) => a.g999,
    A: (x, at) => parityGold10g(x.cg, x.fx, dutyAt('gold', at)), B: (x, at) => mcxSpotAdj(x.mg, x.mgExp || nearExpiry('gold', at), Date.parse(at)) },
  ibja_s: { board: 'ibja', metal: 'silver', unit: 'kg', actual: (a) => a.s999,
    A: (x, at) => paritySilverKg(x.cs, x.fx, dutyAt('silver', at)), B: (x, at) => mcxSpotAdj(x.ms, x.msExp || nearExpiry('silver', at), Date.parse(at)) },
  ch_g22: { board: 'chennai', metal: 'gold', unit: 'g', actual: (a) => a.g22,
    A: (x, at) => div(parityGold10g(x.cg, x.fx, dutyAt('gold', at)), 10), B: (x, at) => div(mcxSpotAdj(x.mg, x.mgExp || nearExpiry('gold', at), Date.parse(at)), 10) },
  ch_s: { board: 'chennai', metal: 'silver', unit: 'g', actual: (a) => a.silver_g,
    A: (x, at) => div(paritySilverKg(x.cs, x.fx, dutyAt('silver', at)), 1000), B: (x, at) => div(mcxSpotAdj(x.ms, x.msExp || nearExpiry('silver', at), Date.parse(at)), 1000) },
};
const div = (v, d) => (v == null ? null : v / d);

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const rms = (a) => Math.sqrt(mean(a.map((v) => v * v)));

/** Premium/discount ratio from the last n prints: exponentially weighted mean of (actual / raw - 1),
 * newest print weighted most (half-life HALF_LIFE prints), so a drifting premium is followed quickly. */
export function calibrate(rows, tkey, method, n, h = HALF_LIFE) {
  const T = TARGETS[tkey];
  const res = [];
  for (let i = rows.length - 1; i >= 0 && res.length < n; i--) {
    const r = rows[i];
    const act = T.actual(r.a);
    const raw = T[method](r.x, r.t);
    if (act > 0 && raw > 0) res.push(act / raw - 1);
  }
  if (!res.length) return null;
  let sw = 0, sv = 0;
  res.forEach((v, j) => { const w = Math.pow(0.5, j / h); sw += w; sv += w * v; });
  const m = sv / sw;
  const sd = res.length > 1 ? Math.sqrt(res.reduce((s, v) => s + (v - m) ** 2, 0) / (res.length - 1)) : 0;
  return { offset: m, n: res.length, sd, last: res[0] };
}

function blendWeights(errA, errB) {
  if (errA.length < 3 || errB.length < 3) return { wA: 0.5, wB: 0.5 };
  const a = 1 / Math.max(rms(errA) ** 2, 1e-8), b = 1 / Math.max(rms(errB) ** 2, 1e-8);
  return { wA: a / (a + b), wB: b / (a + b) };
}

/** Walk-forward backtest: every print predicted using only the prints before it. Errors are fractions (pred/actual - 1). */
export function backtest(allRows, tkey, { n, hl = HALF_LIFE, maxRows = 20 } = {}) {
  const T = TARGETS[tkey];
  n = n || CAL_N[T.board];
  const rows = allRows.filter((r) => r.k === T.board && T.actual(r.a) > 0);
  const out = [];
  const eA = [], eB = [], eM = [], eN = [];
  for (let i = MIN_PRIOR; i < rows.length; i++) {
    const prior = rows.slice(0, i), r = rows[i], act = T.actual(r.a);
    const cA = calibrate(prior, tkey, "A", n, hl), cB = calibrate(prior, tkey, "B", n, hl);
    const rA = T.A(r.x, r.t), rB = T.B(r.x, r.t);
    const pA = cA && rA ? rA * (1 + cA.offset) : null;
    const pB = cB && rB ? rB * (1 + cB.offset) : null;
    const { wA, wB } = blendWeights(eA.slice(-W_WINDOW), eB.slice(-W_WINDOW));
    const pM = pA && pB ? pA * wA + pB * wB : pA || pB;
    const naive = T.actual(prior[prior.length - 1].a);
    const row = { date: r.date, sess: r.sess, actual: act, pA, pB, pM, naive, mcxHow: r.x[T.metal === 'gold' ? 'mgHow' : 'msHow'] };
    if (pA) eA.push(pA / act - 1);
    if (pB) eB.push(pB / act - 1);
    if (pM) eM.push(pM / act - 1);
    eN.push(naive / act - 1);
    out.push(row);
  }
  const tail = (a) => a.slice(-maxRows);
  const stat = (a) => (a.length ? { n: a.length, mape: mean(a.map(Math.abs)), rmse: rms(a), bias: mean(a) } : null);
  const w = blendWeights(eA.slice(-W_WINDOW), eB.slice(-W_WINDOW));
  return { rows: tail(out), A: stat(tail(eA)), B: stat(tail(eB)), M: stat(tail(eM)), naive: stat(tail(eN)), weights: w };
}

/** Prediction for the current inputs. x = {cg, cs, fx, mg, ms, mgExp, msExp}; at = ISO time of the inputs. */
export function predict(allRows, tkey, x, at, bt) {
  const T = TARGETS[tkey];
  const rows = allRows.filter((r) => r.k === T.board && T.actual(r.a) > 0);
  const n = CAL_N[T.board];
  const cA = calibrate(rows, tkey, 'A', n), cB = calibrate(rows, tkey, 'B', n);
  const rA = T.A(x, at), rB = T.B(x, at);
  const pA = cA && rA ? rA * (1 + cA.offset) : null;
  const pB = cB && rB ? rB * (1 + cB.offset) : null;
  bt = bt || backtest(allRows, tkey);
  const { wA, wB } = pA && pB ? bt.weights : { wA: pA ? 1 : 0, wB: pB ? 1 : 0 };
  const p = pA && pB ? pA * wA + pB * wB : pA || pB;
  const band = Math.max(0.0015, Z80 * ((bt.M && bt.M.rmse) || 0.01));
  const last = rows[rows.length - 1];
  return { tkey, p, lo: p ? p * (1 - band) : null, hi: p ? p * (1 + band) : null, band,
    A: { raw: rA, cal: cA, p: pA, w: wA }, B: { raw: rB, cal: cB, p: pB, w: wB },
    last: last ? { value: T.actual(last.a), date: last.date, sess: last.sess, t: last.t, src: last.src } : null,
    prev: rows.length > 1 ? T.actual(rows[rows.length - 2].a) : null, bt };
}

/** IBJA 22K (916) as a share of 24K (999), from recent prints (IBJA prices 916 at exactly 0.916 x 999). */
export function ratio916(allRows, n = 10) {
  const r = allRows.filter((x) => x.k === 'ibja' && x.a.g999 > 0 && x.a.g916 > 0).slice(-n);
  return r.length ? mean(r.map((x) => x.a.g916 / x.a.g999)) : 0.916;
}

export const withGst = (v) => (v == null ? null : v * (1 + GST));

/** Direction of a change: 1 up, -1 down, 0 flat (within eps fraction). */
export function dir(now, before, eps = 0.0002) {
  if (!(now > 0) || !(before > 0)) return null;
  const d = now / before - 1;
  return Math.abs(d) <= eps ? 0 : d > 0 ? 1 : -1;
}

// ---- time helpers: MYT (UTC+8) with IST (UTC+5:30)
const fmtIn = (ms, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(ms).replace(' ', ' ').toUpperCase();
const dayIn = (ms, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short' }).format(ms);
export function fmtMytIst(iso, withDay = true) {
  if (!iso) return '—';
  const ms = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const d = withDay ? `${dayIn(ms, 'Asia/Kuala_Lumpur')}, ` : '';
  return `${d}${fmtIn(ms, 'Asia/Kuala_Lumpur')} MYT · ${fmtIn(ms, 'Asia/Kolkata')} IST`;
}
export function ageText(iso, nowMs = Date.now()) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const m = Math.max(0, Math.round((nowMs - ms) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
