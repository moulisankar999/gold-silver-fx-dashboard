import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../assets/predict-calc.js';

test('COMEX parity: gold per 10 g and silver per kg include 15% duty', () => {
  const g = C.parityGold10g(3539, 92.67);
  assert.ok(Math.abs(g - 3539 * 92.67 / 31.1035 * 10 * 1.15) < 1e-6);
  assert.ok(Math.abs(C.paritySilverKg(41.08, 92.67) - 41.08 * 32.1507 * 92.67 * 1.15) < 1e-6);
  assert.equal(C.parityGold10g(null, 92), null);
});

test('MCX spot adjustment removes carry to expiry', () => {
  const at = Date.parse('2026-11-04T17:30:00Z');
  const v = C.mcxSpotAdj(100000, '2026-12-04', at);
  assert.ok(Math.abs(v - 100000 / (1 + 0.065 * 30 / 365)) < 0.01);
  assert.equal(C.nearExpiry('gold', '2026-11-21'), '2026-12-05');
  assert.equal(C.nearExpiry('silver', '2026-12-10'), '2027-03-05');
});

const mk = (n, prem) => Array.from({ length: n }, (_, i) => {
  const cg = 3500 + i * 10, fx = 92;
  const g = C.parityGold10g(cg, fx) * (1 + prem);
  return { k: 'ibja', date: `2026-11-${String(i + 1).padStart(2, '0')}`, sess: 'AM', t: `2026-11-${String(i + 1).padStart(2, '0')}T06:30:00Z`,
    a: { g999: g, g916: g * 0.916, s999: 150000 }, x: { cg, cs: 41, fx, mg: g, ms: 150000 } };
});

test('calibration recovers a constant premium; backtest error ~0', () => {
  const rows = mk(14, 0.01);
  const c = C.calibrate(rows, 'ibja_g', 'A', 10);
  assert.ok(Math.abs(c.offset - 0.01) < 1e-9);
  const bt = C.backtest(rows, 'ibja_g');
  assert.ok(bt.A.mape < 1e-9);
  const p = C.predict(rows, 'ibja_g', { cg: 3700, cs: 41, fx: 92, mg: null, ms: null }, '2026-11-20T06:30:00Z', bt);
  assert.ok(Math.abs(p.p - C.parityGold10g(3700, 92) * 1.01) < 1e-6);   // MCX missing -> method A only
  assert.ok(p.lo < p.p && p.hi > p.p);
  assert.ok(Math.abs(C.ratio916(rows) - 0.916) < 1e-12);
});

test('direction and GST helpers', () => {
  assert.equal(C.dir(101, 100), 1); assert.equal(C.dir(99, 100), -1); assert.equal(C.dir(100.001, 100), 0);
  assert.ok(Math.abs(C.withGst(100) - 103) < 1e-9);
});

test('prediction duty follows the tax file (by print date)', () => {
  const base = C.parityGold10g(3500, 90);
  C.setTaxes({ duty: 0.06, gst: 0.03, dutyAt: (metal, at) => (at >= '2026-12-02' ? 0.06 : 0.15) });
  assert.ok(Math.abs(C.TARGETS.ibja_g.A({ cg: 3500, fx: 90 }, '2026-12-01T06:30:00Z') - base) < 1e-6);
  assert.ok(Math.abs(C.TARGETS.ibja_g.A({ cg: 3500, fx: 90 }, '2026-12-03T06:30:00Z') - base / 1.15 * 1.06) < 1e-6);
  assert.ok(Math.abs(C.withGst(100) - 103) < 1e-9);
  C.setTaxes({ duty: 0.15, gst: 0.03 });
  assert.ok(Math.abs(C.parityGold10g(3500, 90) - base) < 1e-6);
});
