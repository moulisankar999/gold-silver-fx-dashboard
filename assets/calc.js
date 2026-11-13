// Pure maths + time helpers. No DOM. Unit-tested in tests/calc.test.mjs.
export const G_PER_OZ = 31.1035;      // grams per troy ounce
export const OZ_PER_KG = 32.1507;     // troy ounces per kilogram
export const UNIT_FACTOR = { g: 1, '10g': 10, kg: 1000 };
// Gold (HS 7108) and silver (HS 7106): BCD 10% + AIDC 5% = 15% customs duty, then IGST 3% on the duty-paid value.
// In force since 13 May 2026 (Notification Nos. 15/2026-Customs and 16/2026-Customs). A cut back to 6% has been
// reported as "under consideration" since Aug 2026 but is NOT notified, so 15% stays until a new notification.
export const DUTY = { bcd: 0.10, aidc: 0.05, gst: 0.03 };
export const DUTY_SOURCE = {
  text: 'BCD 10% + AIDC 5% = 15% on gold and silver since 13 May 2026 (Customs Notifications 15/2026 & 16/2026); GST 3% on top.',
  url: 'https://www.business-standard.com/economy/news/india-hikes-import-duty-on-gold-and-silver-to-15-platinum-to-15-4-126051300762_1.html',
};

export const IST_OFFSET_MIN = 330;
export const MYT_OFFSET_MIN = 480;

/** Convert a per-gram value into the selected unit. */
export function toUnit(perGram, unit) {
  if (perGram == null || !Number.isFinite(perGram)) return null;
  return perGram * UNIT_FACTOR[unit];
}

/** USD/oz spot to INR per g, 10g and kg (kg uses 32.1507 oz/kg). */
export function spotToInr(usdPerOz, usdInr) {
  if (!(usdPerOz > 0) || !(usdInr > 0)) return null;
  const perG = (usdPerOz / G_PER_OZ) * usdInr;
  return { perG, per10g: perG * 10, perKg: usdPerOz * OZ_PER_KG * usdInr, usdPerKg: usdPerOz * OZ_PER_KG };
}

/** Value per gram from a spot quote, but consistent with the kg figure when unit is kg. */
export function spotInUnit(usdPerOz, usdInr, unit) {
  const s = spotToInr(usdPerOz, usdInr);
  if (!s) return null;
  return unit === 'kg' ? s.perKg : unit === '10g' ? s.per10g : s.perG;
}

/** Chennai boards do not post 24K; derive it from 22K the same way LiveChennai does (x 24/22). */
export function gold24From22(g22) {
  if (!(g22 > 0)) return null;
  return (g22 * 24) / 22;
}

/** IBJA board: gold per 10g, silver per kg -> per gram. */
export const ibjaGoldPerG = (per10g) => (per10g > 0 ? per10g / 10 : null);
export const ibjaSilverPerG = (perKg) => (perKg > 0 ? perKg / 1000 : null);

/**
 * Silver landed cost in India.
 * base = international price in INR; duty = base x (BCD + AIDC); GST = 3% of (base + duty).
 */
export function silverLanded(baseInr, d = DUTY) {
  if (!(baseInr > 0)) return null;
  const bcd = baseInr * d.bcd;
  const aidc = baseInr * d.aidc;
  const duty = bcd + aidc;
  const dutyPaid = baseInr + duty;
  const gst = dutyPaid * d.gst;
  return { base: baseInr, bcd, aidc, duty, dutyPaid, gst, landed: dutyPaid + gst };
}

/**
 * One row of the Simple view, all per gram in INR.
 * intl = international price in INR. local = Indian board rate (IBJA / Chennai, which exclude GST).
 * World row (no local): final = intl, no taxes.
 * India / Chennai: duty = 15% of intl; premium = local - (intl + duty) (dealer premium, or discount if negative);
 * GST = 3% of local; final = local + GST. So intl + duty + premium + GST = final exactly.
 */
export function simpleRow(intl, local = null, d = DUTY) {
  if (!(intl > 0)) return null;
  if (local == null) return { intl, duty: null, gst: null, premium: null, final: intl, dutyPct: null };
  if (!(local > 0)) return null;
  const dutyPct = d.bcd + d.aidc;
  const duty = intl * dutyPct;
  const premium = local - (intl + duty);
  const gst = local * d.gst;
  return { intl, duty, gst, premium, final: local + gst, dutyPct, local };
}

/** Markup of price over a reference, as amount and %. */
export function markup(price, ref) {
  if (!(price > 0) || !(ref > 0)) return null;
  const amount = price - ref;
  return { amount, pct: (amount / ref) * 100 };
}

export function pctChange(now, before) {
  if (!(now > 0) || !(before > 0)) return null;
  return { abs: now - before, pct: ((now - before) / before) * 100 };
}

// ---------------------------------------------------------------- time

/** Wall-clock parts of a Date in a fixed-offset zone. */
export function zoneParts(date, offsetMin) {
  const d = new Date(date.getTime() + offsetMin * 60000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(),
    mi: d.getUTCMinutes(), dow: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/** Date at a wall-clock time in a fixed-offset zone. */
export function zoneDate(y, mo, d, h, mi, offsetMin) {
  return new Date(Date.UTC(y, mo - 1, d, h, mi) - offsetMin * 60000);
}

function hm12(p) {
  const h = p.h % 12 || 12;
  return `${h}:${String(p.mi).padStart(2, '0')} ${p.h < 12 ? 'AM' : 'PM'}`;
}
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** "3:45 PM MYT · 1:15 PM IST", with the MYT date prefixed when not today (MYT). */
export function fmtMytIst(iso, now = new Date()) {
  if (!iso) return '—';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '—';
  const m = zoneParts(t, MYT_OFFSET_MIN), i = zoneParts(t, IST_OFFSET_MIN), n = zoneParts(now, MYT_OFFSET_MIN);
  const sameDay = m.y === n.y && m.mo === n.mo && m.d === n.d;
  const datePart = sameDay ? '' : `${m.d} ${MON[m.mo - 1]}, `;
  return `${datePart}${hm12(m)} MYT · ${hm12(i)} IST`;
}

export function ageMinutes(iso, now = new Date()) {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? Infinity : (now.getTime() - t) / 60000;
}

export function fmtAge(min) {
  if (!Number.isFinite(min)) return '';
  if (min < 1) return 'just now';
  if (min < 60) return `${Math.round(min)} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} d ago`;
}

/** US daylight time (second Sun Mar -> first Sun Nov). MCX closes 11:30 PM IST then, 11:55 PM IST otherwise. */
export function usDst(date) {
  const y = date.getUTCFullYear();
  const nthSunday = (month, n) => { const d = new Date(Date.UTC(y, month, 1)); const first = (7 - d.getUTCDay()) % 7; return Date.UTC(y, month, 1 + first + 7 * (n - 1)); };
  const start = nthSunday(2, 2) + 7 * 3600e3;  // ~2 AM US Eastern
  const end = nthSunday(10, 1) + 6 * 3600e3;
  return date.getTime() >= start && date.getTime() < end;
}

/** MCX evening/day session: Mon-Fri 9:00 AM to 11:30 PM IST (11:55 PM during US winter). Exchange holidays not known here. */
export function mcxSession(now = new Date()) {
  const p = zoneParts(now, IST_OFFSET_MIN);
  const closeMin = usDst(now) ? 23 * 60 + 30 : 23 * 60 + 55;
  const closeLabel = closeMin === 23 * 60 + 30 ? '11:30 PM' : '11:55 PM';
  const weekday = p.dow >= 1 && p.dow <= 5;
  const open = weekday && p.minutes >= 9 * 60 && p.minutes < closeMin;
  let label;
  if (open) label = `Open · closes ${closeLabel} IST`;
  else if (!weekday) label = 'Closed · weekend';
  else if (p.minutes < 9 * 60) label = 'Closed · opens 9:00 AM IST';
  else label = 'Closed · opens 9:00 AM IST next weekday';
  return { open, label, closeLabel };
}

/** IBJA print window: AM ~12:05 IST, PM ~5:00 PM IST, Mon-Fri. Holidays not modelled. */
export function ibjaWindow(now = new Date()) {
  const p = zoneParts(now, IST_OFFSET_MIN);
  const weekday = p.dow >= 1 && p.dow <= 5;
  if (!weekday) return { phase: 'weekend', label: 'No prints today (weekend)', expect: null };
  if (p.minutes < 12 * 60 + 5) return { phase: 'pre', label: 'AM print due ~12:05 PM IST', expect: 'prev' };
  if (p.minutes < 17 * 60) return { phase: 'am', label: 'AM print out · PM due ~5:00 PM IST', expect: 'am' };
  return { phase: 'pm', label: 'PM print window (~5:00 PM IST)', expect: 'pm' };
}

/** Latest IST date (YYYY-MM-DD) on which an IBJA print should already exist (ignores holidays). */
export function ibjaExpectedDate(now = new Date()) {
  let t = new Date(now.getTime());
  for (let k = 0; k < 10; k++) {
    const p = zoneParts(t, IST_OFFSET_MIN);
    const weekday = p.dow >= 1 && p.dow <= 5;
    const printed = k > 0 || p.minutes >= 12 * 60 + 35; // 30 min grace after 12:05
    if (weekday && printed) return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
    t = new Date(t.getTime() - 86400e3);
  }
  return null;
}

/** MJDTA posts ~9:30 AM IST (and ~3:30 PM IST on some days), Mon-Sat. Stale if today's morning print is missing after 10:30 AM IST. */
export function mjdtaStale(updatedIso, now = new Date()) {
  if (!updatedIso) return true;
  const p = zoneParts(now, IST_OFFSET_MIN);
  const u = zoneParts(new Date(updatedIso), IST_OFFSET_MIN);
  const sameDay = u.y === p.y && u.mo === p.mo && u.d === p.d;
  if (p.dow === 0) return ageMinutes(updatedIso, now) > 60 * 60; // Sunday: tolerate Saturday's print
  if (p.minutes >= 10 * 60 + 30) return !sameDay;
  return ageMinutes(updatedIso, now) > 30 * 60;
}

/** MCX gold/silver near-month: expiry = 5th of the contract month (or preceding weekday; holidays not modelled). */
export function mcxExpiry(year, month) {
  let d = new Date(Date.UTC(year, month - 1, 5));
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d = new Date(d.getTime() - 86400e3);
  return d.toISOString().slice(0, 10);
}

/** Near-month contract an IST date should be trading (rolls after expiry). Gold/silver contracts are bi-monthly-ish; caller compares with scraped contract. */
export function nearMonthAfter(isoDate, expiryIso) {
  return isoDate > expiryIso; // true => contract expired, should have rolled
}

export function fmtINR(v, dp = 0) {
  if (v == null || !Number.isFinite(v)) return '—';
  return '₹' + v.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
export function fmtNum(v, dp = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
export function fmtUSD(v, dp = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
/** Sensible decimals for a rupee figure in the chosen unit. */
export function dpFor(v) { return Math.abs(v) < 1000 ? 2 : 0; }
