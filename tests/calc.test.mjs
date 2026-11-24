import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../assets/calc.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} != ${b}`);

test('unit conversion from per-gram', () => {
  assert.equal(C.toUnit(200, 'g'), 200);
  assert.equal(C.toUnit(200, '10g'), 2000);
  assert.equal(C.toUnit(200, 'kg'), 200000);
  assert.equal(C.toUnit(null, 'kg'), null);
});

test('spot USD/oz -> INR per g / 10g / kg', () => {
  const s = C.spotToInr(4000, 90);
  close(s.perG, 4000 / 31.1035 * 90);
  close(s.per10g, s.perG * 10);
  close(s.perKg, 4000 * 32.1507 * 90);
  close(s.usdPerKg, 4000 * 32.1507);
  // the two constants agree to < 0.001%
  assert.ok(Math.abs(s.perKg / (s.perG * 1000) - 1) < 1e-5);
  assert.equal(C.spotToInr(0, 90), null);
  assert.equal(C.spotToInr(4000, null), null);
  close(C.spotInUnit(50, 93, 'kg'), 50 * 32.1507 * 93);
});

test('24K from 22K uses 24/22 (matches snapshot: 13,210 -> 14,411)', () => {
  assert.equal(Math.round(C.gold24From22(13210)), 14411);
  assert.equal(C.gold24From22(0), null);
});

test('IBJA board units', () => {
  assert.equal(C.ibjaGoldPerG(142420), 14242);
  assert.equal(C.ibjaSilverPerG(186000), 186);
});

test('silver duty + GST maths: base x 1.15 x 1.03', () => {
  const L = C.silverLanded(100000);
  close(L.bcd, 10000);
  close(L.aidc, 5000);
  close(L.duty, 15000);
  close(L.dutyPaid, 115000);
  close(L.gst, 3450);           // 3% of duty-paid, not of base
  close(L.landed, 118450);
  close(L.landed / L.base, 1.1845);
  assert.equal(C.silverLanded(0), null);
});

test('silver landed from a real-looking quote', () => {
  const usdOz = 51.009, usdInr = 93.9425;
  const base = usdOz * 32.1507 * usdInr;
  const L = C.silverLanded(base);
  close(L.landed, base * 1.15 * 1.03);
});

test('markup amount and %', () => {
  const m = C.markup(181999, 150000);
  close(m.amount, 31999);
  close(m.pct, 21.332666666);
  assert.equal(C.markup(null, 1), null);
  const n = C.markup(90, 100);
  close(n.amount, -10); close(n.pct, -10);
});

test('MYT/IST formatting', () => {
  const now = new Date('2026-11-12T09:00:00Z');
  assert.equal(C.fmtMytIst('2026-11-12T04:08:00Z', now), '12:08 PM MYT · 9:38 AM IST');
  assert.equal(C.fmtMytIst('2026-11-11T11:30:00Z', now), '11 Nov, 7:30 PM MYT · 5:00 PM IST');
  assert.equal(C.fmtMytIst(null), '—');
});

test('MCX session hours (IST, US winter close 11:55 PM)', () => {
  assert.equal(C.mcxSession(new Date('2026-11-12T03:29:00Z')).open, false); // 8:59 IST
  assert.equal(C.mcxSession(new Date('2026-11-12T03:30:00Z')).open, true);  // 9:00 IST
  assert.equal(C.mcxSession(new Date('2026-11-12T18:20:00Z')).open, true);  // 11:50 PM IST, Nov = US winter
  assert.equal(C.mcxSession(new Date('2026-07-15T18:05:00Z')).open, false); // 11:35 PM IST, US summer
  assert.equal(C.mcxSession(new Date('2026-11-14T06:00:00Z')).open, false); // Saturday
});

test('IBJA expected print date skips weekends and waits for 12:35 IST', () => {
  assert.equal(C.ibjaExpectedDate(new Date('2026-11-12T05:00:00Z')), '2026-11-11'); // Thu 10:30 IST
  assert.equal(C.ibjaExpectedDate(new Date('2026-11-12T08:00:00Z')), '2026-11-12'); // Thu 13:30 IST
  assert.equal(C.ibjaExpectedDate(new Date('2026-11-15T08:00:00Z')), '2026-11-13'); // Sunday -> Friday
});

test('MJDTA staleness', () => {
  const now = new Date('2026-11-12T08:00:00Z'); // 13:30 IST Thu
  assert.equal(C.mjdtaStale('2026-11-12T09:38:00+05:30', now), false);
  assert.equal(C.mjdtaStale('2026-11-11T15:30:00+05:30', now), true);
});

test('MCX expiry: 5th or previous weekday', () => {
  assert.equal(C.mcxExpiry(2026, 12), '2026-12-04'); // 5 Dec 2026 is a Saturday
  assert.equal(C.mcxExpiry(2027, 2), '2027-02-05');
});

test('simple view row: columns add up to the final price', () => {
  const r = C.simpleRow(11720, 13769);
  close(r.duty, 11720 * 0.15);
  close(r.gst, 11720 * 1.15 * 0.03);
  close(r.final, 11720 * 1.15 * 1.03);
  close(r.intl + r.duty + r.gst, r.final);
  close(r.market, 13769 * 1.03);
  close(r.margin, 13769 * 1.03 - 11720 * 1.15 * 1.03);
  close(r.final + r.margin, r.market);
  close(r.marginPct, (r.margin / r.final) * 100);
  close(r.premium, 13769 - 11720 * 1.15);
  // Same metal, two markets: identical landed total, different margins.
  const r2 = C.simpleRow(11720, 13000);
  close(r2.final, r.final);
  assert.ok(r2.margin < r.margin);
  // Board below landed cost = discount.
  assert.ok(C.simpleRow(11720, 13000 / 1.2).margin < 0);
  const w = C.simpleRow(11720);
  assert.equal(w.duty, null); assert.equal(w.final, 11720);
  assert.equal(C.simpleRow(0, 100), null);
  assert.equal(C.simpleRow(100, 0), null);
  close(C.DUTY.bcd + C.DUTY.aidc, 0.15);
});

test('boardLabel always carries the date and says Today vs Last', async () => {
  const { boardLabel } = await import('../assets/calc.js');
  const now = new Date('2026-11-24T11:25:00Z'); // 4:55 PM IST Tue
  const a = boardLabel('2026-11-24T09:37:00+05:30', now);
  assert.equal(a.today, true);
  assert.equal(a.text, "Today's MJDTA board · 24 Nov, 9:37 AM IST (12:07 PM MYT)");
  assert.match(a.next, /tomorrow/);
  const b = boardLabel('2026-11-21T09:41:00+05:30', new Date('2026-11-23T03:00:00Z'));
  assert.equal(b.today, false);
  assert.match(b.text, /^Last MJDTA board · 21 Nov, 9:41 AM IST/);
  assert.match(b.next, /due ~9:30 AM IST/);
});

test('unchangedSince finds the start of the latest unchanged run', async () => {
  const { unchangedSince } = await import('../assets/calc.js');
  const s = [[100, 180], [200, 175], [300, 175]];
  assert.equal(unchangedSince(s, 175), 200000);
  assert.equal(unchangedSince(s, 170), null);
});
