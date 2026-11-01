#!/usr/bin/env node
/* Checks the engine: parsing, units, and that training recovers known recipes.
 *   node tools/test-engine.js
 */
'use strict';
const assert = require('assert');
const E = require('../js/engine.js');
const S = require('./make-sample.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: got ${a}, expected ${b} (+-${tol})`);

test('thaal counts', () => {
  assert.strictEqual(E.parseThaals('74+15'), 89);
  assert.strictEqual(E.parseThaals('74 + 15 thaal'), 89);
  assert.strictEqual(E.parseThaals(50), 50);
  assert.strictEqual(E.parseThaals('120 thaals'), 120);
  assert.strictEqual(E.parseThaals(''), 0);
});

test('quantities and units', () => {
  assert.deepStrictEqual(E.parseQuantity('500', 'gm'), { value: 0.5, unit: 'kg' });
  assert.deepStrictEqual(E.parseQuantity('2.5 kg'), { value: 2.5, unit: 'kg' });
  assert.deepStrictEqual(E.parseQuantity('750ml'), { value: 0.75, unit: 'L' });
  assert.deepStrictEqual(E.parseQuantity('2', 'dozen'), { value: 24, unit: 'pcs' });
  assert.deepStrictEqual(E.parseQuantity('1 1/2', 'ltr'), { value: 1.5, unit: 'L' });
  assert.strictEqual(E.parseQuantity('abc'), null);
  assert.strictEqual(E.formatQty(0.35, 'kg').text, '350 g');
  assert.strictEqual(E.formatQty(12.43, 'kg').text, '12.4 kg');
  assert.strictEqual(E.formatQty(0.075, 'L').text, '75 ml');
  assert.strictEqual(E.formatQty(10.2, 'pcs', { whole: true }).text, '11 pcs');
});

test('dates (day first) and meals', () => {
  assert.strictEqual(E.parseDate('05/04/2026'), '2026-04-05');
  assert.strictEqual(E.parseDate('2026-04-05'), '2026-04-05');
  assert.strictEqual(E.parseDate('5 Apr 2026'), '2026-04-05');
  assert.strictEqual(E.parseDate(46117), '2026-04-05'); // Excel serial
  assert.strictEqual(E.parseMeal('LUNCH'), 'Lunch');
  assert.strictEqual(E.parseMeal('raat'), 'Dinner');
});

test('menu splitting', () => {
  assert.deepStrictEqual(E.splitDishes('Aloo Pitha + Dal Gosht, Chawal'), ['Aloo Pitha', 'Dal Gosht', 'Chawal']);
});

test('header auto-mapping', () => {
  const m = E.autoMapColumns(['Date', 'Lunch/Dinner', 'No of Thaal', 'Menu', 'Raw Material', 'Quantity', 'UOM']);
  assert.deepStrictEqual(m, { date: 0, meal: 1, thaals: 2, menu: 3, ingredient: 4, qty: 5, unit: 6 });
});

// --- training on the sample data ---------------------------------------
const rows = S.generate();
const csv = E.parseDelimited(S.toCsv(rows));
const imp = E.rowsToMenus(csv, E.autoMapColumns(csv[0]), { defaultUnit: 'kg' });
const model = E.train(imp.menus, { sample: true });

test('import groups rows into menus', () => {
  assert.ok(imp.menus.length > 80, 'expected many menus, got ' + imp.menus.length);
  assert.strictEqual(imp.warnings.length, 0, imp.warnings.join('; '));
  assert.ok(imp.menus.every((m) => m.thaals > 0 && m.dishes.length >= 1));
});

test('training recovers per-thaal recipes (within 10%)', () => {
  let checked = 0;
  for (const [dish, recipe] of Object.entries(S.TRUE_RECIPES)) {
    const d = model.dishes[E.normKey(dish)];
    assert.ok(d, 'missing dish ' + dish);
    for (const [ing, [q, u]] of Object.entries(recipe)) {
      const got = d.recipe[E.normKey(ing) + '|' + u] || 0;
      near(got, q, Math.max(q * 0.1, 0.004), `${dish} / ${ing}`);
      checked++;
    }
  }
  assert.ok(checked > 60);
});

test('items served with every meal land in "common"', () => {
  for (const [ing, [q, u]] of Object.entries(S.TRUE_COMMON)) {
    near(model.base[E.normKey(ing) + '|' + u] || 0, q, q * 0.1, 'common / ' + ing);
  }
});

test('calculate: per thaal x thaals = total', () => {
  const r = E.calculate(model, {}, { dishes: ['aloo pitha', 'Dal Gosht', 'chawal'], thaals: '74+15' });
  assert.strictEqual(r.thaals, 89);
  assert.strictEqual(r.dishes.length, 3);
  assert.ok(r.dishes.every((d) => d.status === 'learned'));
  const potato = r.lines.find((l) => l.name === 'Potato');
  near(potato.perThaal, 0.4, 0.04, 'potato per thaal');
  near(potato.total, potato.perThaal * 89, 1e-9, 'potato total');
  // a menu that was made before is recognised
  const past = model.menus[0];
  const r2 = E.calculate(model, {}, { dishes: past.dishes.map((k) => model.dishes[k].name), thaals: 50, useExact: true });
  assert.ok(r2.exact && r2.exact.count > 0 && r2.exact.used, 'exact past menu found');
});

test('calculate: manual recipe overrides, unknown dish flagged', () => {
  const manual = { 'aloo pitha': { name: 'Aloo Pitha', ingredients: [{ name: 'Potato', qty: '500', unit: 'g' }] } };
  const r = E.calculate(model, manual, { dishes: ['Aloo Pitha', 'Daal Gosht', 'Mystery Dish'], thaals: 10, includeBase: false });
  const potato = r.lines.find((l) => l.name === 'Potato');
  near(potato.total, 5, 1e-9, 'manual potato total');
  assert.strictEqual(r.dishes[0].status, 'manual');
  assert.strictEqual(r.dishes[1].status, 'unknown');
  assert.strictEqual(r.dishes[1].suggestion, 'Dal Gosht');
  assert.strictEqual(r.dishes[2].status, 'unknown');
});

test('suggestions', () => {
  const s = E.suggestDishes(model, {}, 'bhur');
  assert.strictEqual(s[0].name, 'Egg Bhurji');
});

console.log(`\n${passed} passed` + (process.exitCode ? ', some FAILED' : ''));
console.log(`Sample model: ${model.stats.menus} menus, avg error ${(model.stats.avgError * 100).toFixed(1)}%`);
