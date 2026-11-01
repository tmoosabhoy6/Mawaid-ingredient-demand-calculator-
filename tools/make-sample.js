#!/usr/bin/env node
/*
 * Generates SAMPLE history (tools/sample/sample-history.csv) so the app works
 * before the real Mawaid sheets are added. The numbers are made up.
 *
 * It also exports the "true" recipes so tools/test-engine.js can check that
 * training recovers per-thaal quantities from whole-menu totals.
 *
 *   node tools/make-sample.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

// Made-up per-thaal recipes (base units: kg, L, pcs, pkt)
const TRUE_RECIPES = {
  'Dal Gosht': { 'Mutton': [0.45, 'kg'], 'Toor Dal': [0.12, 'kg'], 'Onion': [0.15, 'kg'], 'Tomato': [0.1, 'kg'], 'Ginger Garlic Paste': [0.03, 'kg'], 'Oil': [0.04, 'L'], 'Salt': [0.008, 'kg'], 'Garam Masala': [0.005, 'kg'] },
  'Chawal': { 'Basmati Rice': [0.35, 'kg'], 'Salt': [0.004, 'kg'], 'Ghee': [0.01, 'kg'] },
  'Aloo Pitha': { 'Potato': [0.4, 'kg'], 'Besan': [0.08, 'kg'], 'Oil': [0.06, 'L'], 'Green Chilli': [0.01, 'kg'], 'Salt': [0.005, 'kg'] },
  'Butter Chicken': { 'Chicken': [0.6, 'kg'], 'Butter': [0.05, 'kg'], 'Fresh Cream': [0.06, 'L'], 'Tomato': [0.2, 'kg'], 'Onion': [0.1, 'kg'], 'Ginger Garlic Paste': [0.025, 'kg'], 'Salt': [0.007, 'kg'] },
  'Kheema': { 'Mutton Kheema': [0.5, 'kg'], 'Onion': [0.18, 'kg'], 'Tomato': [0.08, 'kg'], 'Green Peas': [0.08, 'kg'], 'Oil': [0.04, 'L'], 'Salt': [0.007, 'kg'] },
  'Egg Bhurji': { 'Eggs': [12, 'pcs'], 'Onion': [0.15, 'kg'], 'Tomato': [0.1, 'kg'], 'Green Chilli': [0.01, 'kg'], 'Oil': [0.03, 'L'], 'Salt': [0.005, 'kg'] },
  'Pav': { 'Pav': [16, 'pcs'], 'Butter': [0.03, 'kg'] },
  'Roti': { 'Wheat Flour': [0.4, 'kg'], 'Oil': [0.015, 'L'] },
  'Cream Cornflakes': { 'Cornflakes': [0.08, 'kg'], 'Fresh Cream': [0.1, 'L'], 'Sugar': [0.05, 'kg'], 'Milk': [0.3, 'L'] },
  'Sheer Khurma': { 'Milk': [1.2, 'L'], 'Vermicelli': [0.06, 'kg'], 'Sugar': [0.12, 'kg'], 'Dry Fruits': [0.04, 'kg'], 'Ghee': [0.02, 'kg'] },
  'Fruit Salad': { 'Apple': [3, 'pcs'], 'Banana': [4, 'pcs'], 'Custard Powder': [0.03, 'kg'], 'Milk': [0.5, 'L'], 'Sugar': [0.06, 'kg'] },
  'Chicken Biryani': { 'Chicken': [0.7, 'kg'], 'Basmati Rice': [0.4, 'kg'], 'Onion': [0.25, 'kg'], 'Curd': [0.15, 'kg'], 'Biryani Masala': [0.01, 'kg'], 'Ghee': [0.03, 'kg'], 'Oil': [0.03, 'L'], 'Salt': [0.01, 'kg'] },
  'Kadhi': { 'Curd': [0.4, 'kg'], 'Besan': [0.05, 'kg'], 'Ghee': [0.01, 'kg'], 'Salt': [0.004, 'kg'] }
};
// Served with every meal but never written in the menu
const TRUE_COMMON = { 'Salad Cucumber': [0.1, 'kg'], 'Lemon': [2, 'pcs'], 'Drinking Water': [1, 'pkt'] };

const MAINS = ['Dal Gosht', 'Aloo Pitha', 'Butter Chicken', 'Kheema', 'Egg Bhurji', 'Chicken Biryani', 'Kadhi'];
const SIDES = ['Chawal', 'Roti', 'Pav'];
const SWEETS = ['Cream Cornflakes', 'Sheer Khurma', 'Fruit Salad'];

// deterministic random numbers
let seed = 20261101;
function rand() { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }
function pick(list, n) {
  const copy = list.slice(), out = [];
  while (out.length < n && copy.length) out.push(copy.splice(Math.floor(rand() * copy.length), 1)[0]);
  return out;
}
function randomMenu() {
  return pick(MAINS, 1 + (rand() < 0.5 ? 1 : 0))
    .concat(pick(SIDES, Math.floor(rand() * 3)))
    .concat(pick(SWEETS, rand() < 0.6 ? 1 : 0));
}

function displayQty(v, unit) {
  if (unit === 'kg' && v < 1) return [Math.round(v * 1000), 'gm'];
  if (unit === 'L' && v < 1) return [Math.round(v * 1000), 'ml'];
  if (unit === 'pcs' || unit === 'pkt') return [Math.ceil(v), unit === 'pcs' ? 'nos' : 'pkt'];
  return [+v.toFixed(2), unit === 'L' ? 'ltr' : 'kg'];
}

function generate() {
  const rows = [['Date', 'Meal', 'Thaals', 'Menu', 'Ingredient', 'Qty', 'Unit']];
  const start = new Date(Date.UTC(2026, 3, 1));
  for (let day = 0; day < 90; day++) {
    for (const meal of ['Lunch', 'Dinner']) {
      if (rand() < 0.35) continue; // not every meal is served
      const d = new Date(start.getTime() + day * 86400000);
      const date = `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
      const menu = randomMenu();
      const thaals = 40 + Math.floor(rand() * 80);
      const extra = rand() < 0.5 ? 0 : Math.floor(rand() * 20);
      const thaalText = extra ? `${thaals}+${extra}` : String(thaals);
      const total = thaals + extra;
      const sums = {};
      const addAll = (recipe) => {
        for (const [ing, [q, u]] of Object.entries(recipe)) {
          const noise = 1 + (rand() - 0.5) * 0.12; // +-6% cooking variation
          sums[ing] = sums[ing] || [0, u];
          sums[ing][0] += q * total * noise;
        }
      };
      menu.forEach((dish) => addAll(TRUE_RECIPES[dish]));
      addAll(TRUE_COMMON);
      let first = true;
      for (const [ing, [v, u]] of Object.entries(sums)) {
        const [qty, unit] = displayQty(v, u);
        // like many real sheets: menu details only on the first row of each menu
        rows.push(first ? [date, meal, thaalText, menu.join(' + '), ing, qty, unit] : ['', '', '', '', ing, qty, unit]);
        first = false;
      }
    }
  }
  return rows;
}

function toCsv(rows) {
  return rows.map((r) => r.map((c) => {
    const s = String(c);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n') + '\n';
}

if (require.main === module) {
  const out = path.join(__dirname, 'sample', 'sample-history.csv');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, toCsv(generate()));
  console.log('Wrote', path.relative(process.cwd(), out));
}

module.exports = { TRUE_RECIPES, TRUE_COMMON, generate, toCsv };
