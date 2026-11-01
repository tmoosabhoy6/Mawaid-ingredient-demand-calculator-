/*
 * Mawaid Ingredient Engine
 * ------------------------
 * Shared by the web app (browser) and the command-line tools (Node).
 *
 *  - Name / unit / quantity / date normalisation
 *  - Importing historical sheets (one row per ingredient per menu)
 *  - Training: works out "per thaal" quantities for every dish from
 *    whole-menu history (the "exclusion method", done as a
 *    non-negative least-squares fit across all menus)
 *  - Calculating: dishes + thaal count  ->  per thaal + total ingredients
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MawaidEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ENGINE_VERSION = 1;
  var BASE_KEY = '__common__';
  var BASE_NAME = 'Common to every meal';

  /* ------------------------------------------------------------------ */
  /* Names                                                               */
  /* ------------------------------------------------------------------ */

  function normKey(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/[‘’'`"]/g, '')
      // keep latin letters, digits, Gujarati and Devanagari letters, & and ()
      .replace(/[^a-z0-9઀-૿ऀ-ॿ&()]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  function titleCase(s) {
    s = String(s == null ? '' : s).trim().replace(/\s+/g, ' ');
    if (!s) return s;
    // Leave names that already contain capitals alone (e.g. "BBQ Chicken")
    if (/[A-Z]/.test(s)) return s;
    return s.replace(/(^|[\s(\-\/])([a-z])/g, function (m, p, c) { return p + c.toUpperCase(); });
  }

  /** "Aloo Pitha + Dal Gosht, Chawal" -> ["Aloo Pitha", "Dal Gosht", "Chawal"] */
  function splitDishes(text) {
    if (Array.isArray(text)) return text.map(function (s) { return String(s).trim(); }).filter(Boolean);
    return String(text == null ? '' : text)
      .split(/[+,;\n|]|\s\/\s/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  /** Resolve an alias table { normalised alias: canonical name } */
  function applyAlias(name, aliasTable) {
    var k = normKey(name);
    if (aliasTable) {
      var hit = aliasTable[k];
      if (hit) return { key: normKey(hit), name: hit };
    }
    return { key: k, name: titleCase(name) };
  }

  function buildAliasTable(obj) {
    var out = {};
    if (!obj) return out;
    Object.keys(obj).forEach(function (alias) { out[normKey(alias)] = obj[alias]; });
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Numbers, thaals, units                                              */
  /* ------------------------------------------------------------------ */

  function parseNumber(v) {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    var s = String(v == null ? '' : v).trim().replace(/,/g, '');
    if (!s) return NaN;
    // mixed fraction "1 1/2"
    var m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
    if (m) return +m[1] + (+m[2] / +m[3]);
    m = s.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
    if (m) return +m[1] / +m[2];
    m = s.match(/^-?\d*\.?\d+(?:e-?\d+)?$/i);
    return m ? parseFloat(s) : NaN;
  }

  /** Thaal count. Accepts 89, "89", "74+15", "74 + 15 thaal". */
  function parseThaals(v) {
    if (typeof v === 'number') return v > 0 ? v : 0;
    var s = String(v == null ? '' : v);
    var nums = s.match(/\d+(?:\.\d+)?/g);
    if (!nums) return 0;
    if (/[+&]|\band\b/i.test(s)) return nums.reduce(function (a, n) { return a + parseFloat(n); }, 0);
    return parseFloat(nums[0]);
  }

  var UNIT_TABLE = [
    { base: 'kg', f: 1, names: ['kg', 'kgs', 'kilo', 'kilos', 'kilogram', 'kilograms', 'k g'] },
    { base: 'kg', f: 0.001, names: ['g', 'gm', 'gms', 'gram', 'grams', 'grm', 'grms', 'gr'] },
    { base: 'L', f: 1, names: ['l', 'lt', 'lts', 'ltr', 'ltrs', 'litre', 'litres', 'liter', 'liters', 'lit'] },
    { base: 'L', f: 0.001, names: ['ml', 'mls', 'millilitre', 'milliliter', 'millilitres', 'milliliters'] },
    { base: 'pcs', f: 1, names: ['pc', 'pcs', 'piece', 'pieces', 'nos', 'no', 'nag', 'unit', 'units', 'each', 'ea', 'number', 'numbers', 'qty'] },
    { base: 'pcs', f: 12, names: ['dozen', 'dozens', 'dz', 'doz'] },
    { base: 'pkt', f: 1, names: ['pkt', 'pkts', 'packet', 'packets', 'pack', 'packs', 'pouch', 'pouches', 'sachet', 'sachets'] },
    { base: 'bottle', f: 1, names: ['bottle', 'bottles', 'btl', 'btls'] },
    { base: 'box', f: 1, names: ['box', 'boxes', 'carton', 'cartons'] },
    { base: 'bunch', f: 1, names: ['bunch', 'bunches', 'judi', 'jhudi', 'gaddi', 'zudi'] },
    { base: 'tin', f: 1, names: ['tin', 'tins', 'can', 'cans'] },
    { base: 'tray', f: 1, names: ['tray', 'trays'] },
    { base: 'bag', f: 1, names: ['bag', 'bags', 'sack', 'sacks', 'bori'] }
  ];
  var UNIT_LOOKUP = {};
  UNIT_TABLE.forEach(function (u) { u.names.forEach(function (n) { UNIT_LOOKUP[n] = u; }); });

  /** Unit choices offered in the app's drop-downs */
  var UNIT_CHOICES = ['kg', 'g', 'L', 'ml', 'pcs', 'dozen', 'pkt', 'bottle', 'box', 'bunch', 'tin', 'tray', 'bag'];

  /** -> { base: 'kg'|'L'|'pcs'|..., f: factor to base } */
  function normUnit(u, defaultUnit) {
    var k = String(u == null ? '' : u).toLowerCase().replace(/[.\s]+/g, ' ').trim();
    if (!k) k = String(defaultUnit || 'kg').toLowerCase();
    if (UNIT_LOOKUP[k]) return { base: UNIT_LOOKUP[k].base, f: UNIT_LOOKUP[k].f };
    var k2 = k.replace(/\s/g, '');
    if (UNIT_LOOKUP[k2]) return { base: UNIT_LOOKUP[k2].base, f: UNIT_LOOKUP[k2].f };
    return { base: k, f: 1 };
  }

  /**
   * Parse a quantity cell, optionally with a separate unit cell.
   *   ("2.5", "kg") -> {value: 2.5, unit: 'kg'}
   *   ("500 gm")    -> {value: 0.5, unit: 'kg'}
   *   ("2 dozen")   -> {value: 24,  unit: 'pcs'}
   * Value is always in the base unit.
   */
  function parseQuantity(qty, unit, defaultUnit) {
    var value = parseNumber(qty);
    var unitText = unit;
    if (isNaN(value)) {
      var s = String(qty == null ? '' : qty).trim().replace(/,/g, '');
      var m = s.match(/^(\d+\s+\d+\/\d+|\d+(?:\.\d+)?\/\d+(?:\.\d+)?|\d*\.?\d+)\s*([a-zA-Z.\s]*)$/);
      if (!m) return null;
      value = parseNumber(m[1]);
      if (m[2] && m[2].trim() && !(unit && String(unit).trim())) unitText = m[2];
    }
    if (isNaN(value)) return null;
    var nu = normUnit(unitText, defaultUnit);
    return { value: value * nu.f, unit: nu.base };
  }

  var COUNT_UNITS = { pcs: 1, pkt: 1, bottle: 1, box: 1, bunch: 1, tin: 1, tray: 1, bag: 1 };

  function trimNum(v, decimals) {
    var s = v.toFixed(decimals);
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
  }

  function smartNum(v) {
    var a = Math.abs(v);
    if (a === 0) return '0';
    if (a < 0.1) return trimNum(v, 3);
    if (a < 10) return trimNum(v, 2);
    if (a < 100) return trimNum(v, 1);
    return trimNum(v, 0);
  }

  /**
   * Human friendly quantity.
   *   (0.35, 'kg') -> {num:'350', unit:'g'};  (12.4, 'kg') -> {num:'12.4', unit:'kg'}
   *   opts.whole -> round counts (eggs, packets) up to a whole number
   */
  function formatQty(v, base, opts) {
    opts = opts || {};
    if (v == null || isNaN(v)) return { num: '', unit: base, text: '' };
    var num, unit = base;
    if (base === 'kg' && Math.abs(v) < 1 && v !== 0) { num = smartNum(v * 1000); unit = 'g'; }
    else if (base === 'L' && Math.abs(v) < 1 && v !== 0) { num = smartNum(v * 1000); unit = 'ml'; }
    else if (COUNT_UNITS[base] && opts.whole) { num = String(Math.ceil(v - 1e-9)); }
    else num = smartNum(v);
    return { num: num, unit: unit, text: num + ' ' + unit };
  }

  /* ------------------------------------------------------------------ */
  /* Dates and meals                                                     */
  /* ------------------------------------------------------------------ */

  var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function isoFromParts(y, m, d) {
    if (y < 100) y += 2000;
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return '';
    return y + '-' + pad2(m) + '-' + pad2(d);
  }

  /** Dates are read day-first (dd/mm/yyyy) as used in India. Returns 'YYYY-MM-DD' or ''. */
  function parseDate(v) {
    if (v == null || v === '') return '';
    if (v instanceof Date && !isNaN(v)) return isoFromParts(v.getFullYear(), v.getMonth() + 1, v.getDate());
    if (typeof v === 'number') {
      if (v > 20000 && v < 80000) { // Excel serial date
        var d = new Date(Math.round((v - 25569) * 86400000));
        return isoFromParts(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
      }
      return '';
    }
    var s = String(v).trim();
    var m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
    if (m) return isoFromParts(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/);
    if (m) return isoFromParts(+m[3], +m[2], +m[1]);
    m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s\-]+([a-zA-Z]{3,9})[\s\-,]+(\d{2,4})/);
    if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) return isoFromParts(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]);
    m = s.match(/^([a-zA-Z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})/);
    if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) return isoFromParts(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]);
    return '';
  }

  function parseMeal(v, defaultMeal) {
    var s = String(v == null ? '' : v).toLowerCase();
    if (/lunch|bapor|બપોર|noon|afternoon|zohr|zuhr/.test(s)) return 'Lunch';
    if (/dinner|raat|રાત|sanj|સાંજ|night|evening|maghrib|isha/.test(s)) return 'Dinner';
    if (/breakfast|nasto|નાસ્તો|morning|sehri|sahur/.test(s)) return 'Breakfast';
    if (s.trim()) return titleCase(String(v).trim());
    return defaultMeal || 'Dinner';
  }

  /* ------------------------------------------------------------------ */
  /* Importing historical sheets                                         */
  /* ------------------------------------------------------------------ */

  var FIELDS = ['date', 'meal', 'thaals', 'menu', 'ingredient', 'qty', 'unit'];
  var FIELD_LABELS = {
    date: 'Date', meal: 'Lunch / Dinner', thaals: 'Thaal count', menu: 'Menu (dishes)',
    ingredient: 'Ingredient', qty: 'Quantity', unit: 'Unit'
  };
  var FIELD_SYNONYMS = {
    date: ['date', 'day', 'tarikh', 'tareekh', 'dt'],
    meal: ['meal', 'lunch dinner', 'lunch/dinner', 'time', 'session', 'shift', 'waqt', 'type'],
    thaals: ['thaals', 'thaal', 'thals', 'thal', 'thali', 'tiles', 'tile', 'no of thaal', 'thaal count', 'count', 'persons', 'covers'],
    menu: ['menu', 'dishes', 'dish', 'menu items', 'items', 'food', 'jaman'],
    ingredient: ['ingredient', 'ingredients', 'raw material', 'material', 'item name', 'item', 'particulars', 'description', 'name', 'cheez', 'saman'],
    qty: ['qty', 'quantity', 'amount', 'total qty', 'total quantity', 'qnty', 'used', 'consumption'],
    unit: ['unit', 'units', 'uom', 'measure']
  };

  /** Guess which column holds which field from a header row. */
  function autoMapColumns(header) {
    var map = {};
    var used = {};
    var hdr = header.map(function (h) { return normKey(h); });
    FIELDS.forEach(function (field) {
      var syns = FIELD_SYNONYMS[field];
      // exact match first, then "contains"
      for (var pass = 0; pass < 2 && map[field] == null; pass++) {
        for (var s = 0; s < syns.length && map[field] == null; s++) {
          for (var i = 0; i < hdr.length; i++) {
            if (used[i]) continue;
            var h = hdr[i];
            if (!h) continue;
            var ok = pass === 0 ? h === syns[s] : (h.indexOf(syns[s]) >= 0);
            if (ok) { map[field] = i; used[i] = true; break; }
          }
        }
      }
    });
    return map;
  }

  /**
   * Convert sheet rows into menus.
   *   rows:    array of arrays, rows[0] is the header
   *   mapping: { date: colIndex, meal, thaals, menu, ingredient, qty, unit }
   *   opts:    { defaultUnit: 'kg', defaultMeal: 'Dinner' }
   * Blank date / meal / thaals / menu cells are filled from the row above
   * (sheets often only write them on the first row of each menu).
   */
  function rowsToMenus(rows, mapping, opts) {
    opts = opts || {};
    var menus = [];
    var byKey = {};
    var warnings = [];
    var last = { date: '', meal: '', thaals: '', menu: '' };
    function cell(r, f) { return mapping[f] == null || mapping[f] === '' ? '' : r[mapping[f]]; }
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i] || [];
      if (!r.some(function (c) { return c !== '' && c != null; })) continue;
      var rawDate = cell(r, 'date'), rawMeal = cell(r, 'meal'), rawThaals = cell(r, 'thaals'), rawMenu = cell(r, 'menu');
      var newBlock = false;
      if (rawDate !== '' && rawDate != null) { if (String(rawDate) !== String(last.date)) newBlock = true; last.date = rawDate; }
      if (rawMeal !== '' && rawMeal != null) { if (String(rawMeal) !== String(last.meal)) newBlock = true; last.meal = rawMeal; }
      if (rawMenu !== '' && rawMenu != null) { last.menu = rawMenu; }
      if (rawThaals !== '' && rawThaals != null) { last.thaals = rawThaals; }
      else if (newBlock) { last.thaals = ''; }
      var ing = cell(r, 'ingredient');
      if (ing === '' || ing == null) continue;
      var q = parseQuantity(cell(r, 'qty'), cell(r, 'unit'), opts.defaultUnit);
      if (!q || !(q.value > 0)) continue;
      var date = parseDate(last.date);
      var meal = parseMeal(last.meal, opts.defaultMeal);
      var thaals = parseThaals(last.thaals);
      var dishes = splitDishes(last.menu);
      if (!thaals) { warnings.push('Row ' + (i + 1) + ': no thaal count - skipped'); continue; }
      if (!dishes.length) { warnings.push('Row ' + (i + 1) + ': no menu - skipped'); continue; }
      var key = date + '|' + meal + '|' + normKey(last.menu) + '|' + thaals;
      var menu = byKey[key];
      if (!menu) {
        menu = byKey[key] = { date: date, meal: meal, thaals: thaals, dishes: dishes, ingredients: [] };
        menus.push(menu);
      }
      menu.ingredients.push({ name: String(ing).trim(), qty: q.value, unit: q.unit });
    }
    if (warnings.length > 50) warnings = warnings.slice(0, 50).concat(['... and ' + (warnings.length - 50) + ' more']);
    return { menus: menus, warnings: warnings };
  }

  /** Parse CSV / TSV text (handles quotes). Delimiter auto-detected. */
  function parseDelimited(text) {
    text = String(text || '').replace(/^﻿/, '');
    var firstLine = text.split(/\r?\n/)[0] || '';
    var delim = (firstLine.split('\t').length > 1) ? '\t' : (firstLine.split(';').length > firstLine.split(',').length ? ';' : ',');
    var rows = [], row = [], field = '', inQ = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += c;
      } else if (c === '"' && field === '') inQ = true;
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.map(function (r) { return r.map(function (c) { return c.trim(); }); });
  }

  /** Turn confirmed daily files (data/*.json) into training menus. */
  function dayFilesToMenus(dayFiles) {
    var menus = [];
    (dayFiles || []).forEach(function (day) {
      (day.entries || []).forEach(function (e) {
        if (!e.thaals || !e.dishes || !e.dishes.length) return;
        menus.push({
          date: day.date, meal: e.meal, thaals: e.thaals, dishes: e.dishes.slice(),
          ingredients: (e.ingredients || []).filter(function (l) { return l.total > 0; })
            .map(function (l) { return { name: l.name, qty: l.total, unit: l.unit }; })
        });
      });
    });
    return menus;
  }

  /* ------------------------------------------------------------------ */
  /* Training                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Non-negative ridge least squares on a 0/1 design matrix, by coordinate descent.
   *   minimise  sum_m (b_m - sum_j A_mj x_j)^2  +  sum_j pen_j x_j^2,   x >= 0
   * cols[j] = list of row indices where column j is 1.
   */
  function nnlsRidge(cols, b, pen, opts) {
    opts = opts || {};
    var maxIter = opts.maxIter || 3000, tol = opts.tol || 1e-7;
    var J = cols.length, M = b.length;
    var x = new Float64Array(J);
    var r = new Float64Array(M);
    var bmax = 0;
    for (var m = 0; m < M; m++) { r[m] = b[m]; if (Math.abs(b[m]) > bmax) bmax = Math.abs(b[m]); }
    if (bmax === 0) return x;
    for (var it = 0; it < maxIter; it++) {
      var maxDelta = 0;
      for (var j = 0; j < J; j++) {
        var c = cols[j], n = c.length;
        if (!n) continue;
        var g = 0, k;
        for (k = 0; k < n; k++) g += r[c[k]];
        var xn = (x[j] * n + g) / (n + pen[j]);
        if (xn < 0) xn = 0;
        var d = xn - x[j];
        if (d !== 0) {
          for (k = 0; k < n; k++) r[c[k]] -= d;
          x[j] = xn;
          if (Math.abs(d) > maxDelta) maxDelta = Math.abs(d);
        }
      }
      if (maxDelta <= tol * bmax) break;
    }
    return x;
  }

  function round6(v) { return v === 0 ? 0 : +v.toPrecision(6); }

  function median(arr) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var mid = a.length >> 1;
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }

  /**
   * Learn per-thaal quantities for each dish.
   *   menus: [{date, meal, thaals, dishes:[names], ingredients:[{name, qty, unit}]}]
   *          (qty already in base units; use rowsToMenus / dayFilesToMenus)
   *   opts:  { aliases: {dishes:{}, ingredients:{}}, sample: bool, source: string,
   *            dishPenalty: 0.01, basePenalty: 0.1, useBase: true }
   */
  function train(menus, opts) {
    opts = opts || {};
    var aliases = opts.aliases || {};
    var dishAlias = buildAliasTable(aliases.dishes);
    var ingAlias = buildAliasTable(aliases.ingredients);
    var useBase = opts.useBase !== false;
    var dishPenalty = opts.dishPenalty != null ? opts.dishPenalty : 0.01;
    var basePenalty = opts.basePenalty != null ? opts.basePenalty : 0.1;

    var dishes = {}, dishOrder = [];
    var ings = {}, ingOrder = [];
    var ingNameVotes = {};
    var clean = [];

    (menus || []).forEach(function (mn) {
      var thaals = parseThaals(mn.thaals);
      if (!(thaals > 0)) return;
      var dkeys = [];
      splitDishes(mn.dishes).forEach(function (dn) {
        var a = applyAlias(dn, dishAlias);
        if (!a.key || dkeys.indexOf(a.key) >= 0) return;
        if (!dishes[a.key]) { dishes[a.key] = { name: a.name, menus: [], dates: [] }; dishOrder.push(a.key); }
        dkeys.push(a.key);
      });
      if (!dkeys.length) return;
      var amounts = {};
      (mn.ingredients || []).forEach(function (ing) {
        var nu = normUnit(ing.unit);
        var value = +ing.qty * nu.f;
        if (!(value > 0)) return;
        var a = applyAlias(ing.name, ingAlias);
        if (!a.key) return;
        var ik = a.key + '|' + nu.base;
        if (!ings[ik]) { ings[ik] = { name: a.name, unit: nu.base }; ingOrder.push(ik); ingNameVotes[ik] = {}; }
        ingNameVotes[ik][a.name] = (ingNameVotes[ik][a.name] || 0) + 1;
        amounts[ik] = (amounts[ik] || 0) + value;
      });
      var idx = clean.length;
      clean.push({ date: parseDate(mn.date) || String(mn.date || ''), meal: parseMeal(mn.meal), thaals: thaals, dishes: dkeys, amounts: amounts });
      dkeys.forEach(function (k) { dishes[k].menus.push(idx); });
    });

    // most common spelling wins for display
    ingOrder.forEach(function (ik) {
      var votes = ingNameVotes[ik], best = ings[ik].name, bestN = -1;
      Object.keys(votes).forEach(function (n) { if (votes[n] > bestN) { best = n; bestN = votes[n]; } });
      ings[ik].name = best;
    });

    var M = clean.length;
    var J = dishOrder.length;
    var dishIndex = {};
    dishOrder.forEach(function (k, j) { dishIndex[k] = j; });
    var allRows = [];
    for (var m = 0; m < M; m++) allRows.push(m);

    var recipes = {};
    dishOrder.forEach(function (k) { recipes[k] = {}; });
    var base = {};
    var errNum = 0, errDen = 0;
    var ingErrors = {};

    ingOrder.forEach(function (ik) {
      var b = new Float64Array(M);
      var positives = [];
      var relevant = {};
      for (var m = 0; m < M; m++) {
        var a = clean[m].amounts[ik];
        if (a > 0) {
          b[m] = a / clean[m].thaals;
          positives.push(b[m]);
          clean[m].dishes.forEach(function (dk) { relevant[dk] = true; });
        }
      }
      // Only dishes that ever appeared alongside this ingredient can carry it.
      var colKeys = Object.keys(relevant);
      var cols = colKeys.map(function (dk) { return dishes[dk].menus; });
      var pen = colKeys.map(function () { return dishPenalty; });
      if (useBase) { colKeys.push(BASE_KEY); cols.push(allRows); pen.push(basePenalty); }
      var x = nnlsRidge(cols, b, pen);

      // Drop tiny noise coefficients
      var threshold = 0.02 * median(positives);
      var kept = {};
      colKeys.forEach(function (ck, j) {
        if (x[j] > threshold) kept[ck] = x[j];
      });
      Object.keys(kept).forEach(function (ck) {
        if (ck === BASE_KEY) base[ik] = round6(kept[ck]);
        else recipes[ck][ik] = round6(kept[ck]);
      });

      // Fit quality for this ingredient
      var num = 0, den = 0;
      for (var mm = 0; mm < M; mm++) {
        var pred = kept[BASE_KEY] || 0;
        clean[mm].dishes.forEach(function (dk) { pred += kept[dk] || 0; });
        num += Math.abs(pred - b[mm]) * clean[mm].thaals;
        den += b[mm] * clean[mm].thaals;
      }
      if (den > 0) { ingErrors[ik] = num / den; errNum += num / den; errDen += 1; }
    });

    // Dishes that always appear together cannot be separated precisely
    var signature = {};
    dishOrder.forEach(function (k) {
      var sig = dishes[k].menus.join(',');
      (signature[sig] = signature[sig] || []).push(k);
    });

    var outDishes = {};
    dishOrder.forEach(function (k) {
      var d = dishes[k];
      var dates = d.menus.map(function (i) { return clean[i].date; }).filter(Boolean).sort();
      var twins = signature[d.menus.join(',')].filter(function (o) { return o !== k; });
      outDishes[k] = {
        name: d.name,
        count: d.menus.length,
        lastMade: dates.length ? dates[dates.length - 1] : '',
        dates: dates,
        pairedWith: twins.map(function (t) { return dishes[t].name; }),
        recipe: recipes[k]
      };
    });

    var outMenus = clean.map(function (c) {
      var perThaal = {};
      Object.keys(c.amounts).forEach(function (ik) { perThaal[ik] = round6(c.amounts[ik] / c.thaals); });
      return { date: c.date, meal: c.meal, thaals: c.thaals, dishes: c.dishes, perThaal: perThaal };
    });
    outMenus.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });

    var outIngs = {};
    ingOrder.forEach(function (ik) {
      outIngs[ik] = { name: ings[ik].name, unit: ings[ik].unit, fitError: ingErrors[ik] != null ? round6(ingErrors[ik]) : null };
    });

    return {
      engineVersion: ENGINE_VERSION,
      trainedAt: new Date().toISOString(),
      sample: !!opts.sample,
      source: opts.source || '',
      stats: {
        menus: M,
        dishes: J,
        ingredients: ingOrder.length,
        firstDate: outMenus.length ? outMenus[0].date : '',
        lastDate: outMenus.length ? outMenus[outMenus.length - 1].date : '',
        avgError: errDen ? round6(errNum / errDen) : null
      },
      aliases: { dishes: aliases.dishes || {}, ingredients: aliases.ingredients || {} },
      ingredients: outIngs,
      dishes: outDishes,
      base: base,
      menus: outMenus
    };
  }

  function emptyModel() {
    return {
      engineVersion: ENGINE_VERSION, trainedAt: '', sample: false, source: '',
      stats: { menus: 0, dishes: 0, ingredients: 0, firstDate: '', lastDate: '', avgError: null },
      aliases: { dishes: {}, ingredients: {} }, ingredients: {}, dishes: {}, base: {}, menus: []
    };
  }

  /* ------------------------------------------------------------------ */
  /* Calculating                                                         */
  /* ------------------------------------------------------------------ */

  function confidenceOf(count) {
    if (count >= 5) return 'high';
    if (count >= 2) return 'medium';
    if (count >= 1) return 'low';
    return 'none';
  }

  function resolveDishKey(model, manual, name) {
    var a = applyAlias(name, buildAliasTable(model && model.aliases && model.aliases.dishes));
    return a.key;
  }

  function ingKeyFor(model, name, unit) {
    var a = applyAlias(name, buildAliasTable(model && model.aliases && model.aliases.ingredients));
    var nu = normUnit(unit);
    return { key: a.key + '|' + nu.base, name: a.name, unit: nu.base, f: nu.f };
  }

  /** All known dishes (learned + manual) for search / autocomplete */
  function listDishes(model, manual) {
    var out = {};
    Object.keys((model && model.dishes) || {}).forEach(function (k) {
      var d = model.dishes[k];
      out[k] = { key: k, name: d.name, count: d.count, lastMade: d.lastMade, learned: true, manual: false, pairedWith: d.pairedWith || [] };
    });
    Object.keys(manual || {}).forEach(function (k) {
      var m = manual[k];
      if (m.deleted) return;
      if (out[k]) out[k].manual = true;
      else out[k] = { key: k, name: m.name, count: 0, lastMade: '', learned: false, manual: true, pairedWith: [] };
    });
    return Object.keys(out).map(function (k) { return out[k]; });
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    var prev = [], cur = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i];
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  /** Ranked suggestions for a partially typed dish name */
  function suggestDishes(model, manual, text, limit) {
    var q = normKey(text);
    var all = listDishes(model, manual);
    if (!q) return all.sort(function (a, b) { return b.count - a.count; }).slice(0, limit || 8);
    var scored = [];
    all.forEach(function (d) {
      var k = normKey(d.name);
      var score = -1;
      if (k === q) score = 100;
      else if (k.indexOf(q) === 0) score = 80;
      else if (k.split(' ').some(function (w) { return w.indexOf(q) === 0; })) score = 60;
      else if (k.indexOf(q) >= 0) score = 40;
      else {
        var dist = levenshtein(q, k.slice(0, Math.max(q.length, 1)));
        if (q.length >= 4 && dist <= 2) score = 20 - dist;
      }
      if (score >= 0) scored.push({ d: d, s: score + Math.min(d.count, 50) / 10 });
    });
    scored.sort(function (a, b) { return b.s - a.s; });
    return scored.slice(0, limit || 8).map(function (x) { return x.d; });
  }

  /** Closest known dish name for a typo (or null) */
  function didYouMean(model, manual, text) {
    var q = normKey(text);
    if (!q) return null;
    var best = null, bestD = Infinity;
    listDishes(model, manual).forEach(function (d) {
      var dist = levenshtein(q, normKey(d.name));
      if (dist < bestD) { bestD = dist; best = d; }
    });
    var limit = Math.max(2, Math.floor(q.length / 4));
    return best && bestD <= limit ? best : null;
  }

  function sameSet(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (b.indexOf(a[i]) < 0) return false;
    return true;
  }

  /**
   * Work out the ingredients for a menu.
   *   input: { dishes: [names], thaals: number, includeBase: true, useExact: false }
   * Returns:
   *   { thaals, dishes:[{name,key,status,count,confidence,pairedWith,suggestion}],
   *     lines:[{key,name,unit,perThaal,total,sources:[{dish,perThaal}]}],
   *     exact: {count, dates, used} | null }
   */
  function calculate(model, manual, input) {
    model = model || emptyModel();
    manual = manual || {};
    var thaals = parseThaals(input.thaals);
    var lines = {}, order = [];
    var dishInfo = [];
    var keys = [];

    function add(ik, name, unit, perThaal, source) {
      if (!(perThaal > 0)) return;
      if (!lines[ik]) { lines[ik] = { key: ik, name: name, unit: unit, perThaal: 0, sources: [] }; order.push(ik); }
      lines[ik].perThaal += perThaal;
      lines[ik].sources.push({ dish: source, perThaal: perThaal });
    }

    splitDishes(input.dishes).forEach(function (dn) {
      var key = resolveDishKey(model, manual, dn);
      if (!key || keys.indexOf(key) >= 0) return;
      keys.push(key);
      var man = manual[key] && !manual[key].deleted ? manual[key] : null;
      var learned = model.dishes[key];
      var info = {
        name: (man && man.name) || (learned && learned.name) || titleCase(dn),
        key: key,
        status: man ? 'manual' : learned ? 'learned' : 'unknown',
        count: learned ? learned.count : 0,
        confidence: man ? 'manual' : confidenceOf(learned ? learned.count : 0),
        pairedWith: learned ? (learned.pairedWith || []) : [],
        lastMade: learned ? learned.lastMade : '',
        suggestion: null
      };
      if (info.status === 'unknown') {
        var s = didYouMean(model, manual, dn);
        if (s) info.suggestion = s.name;
      }
      dishInfo.push(info);
      if (man) {
        (man.ingredients || []).forEach(function (ing) {
          var q = parseQuantity(ing.qty, ing.unit);
          if (!q || !(q.value > 0)) return;
          var ik = ingKeyFor(model, ing.name, q.unit);
          var known = model.ingredients[ik.key];
          add(ik.key, known ? known.name : ik.name, q.unit, q.value, info.name);
        });
      } else if (learned) {
        Object.keys(learned.recipe || {}).forEach(function (ik) {
          var meta = model.ingredients[ik] || { name: ik.split('|')[0], unit: ik.split('|')[1] };
          add(ik, meta.name, meta.unit, learned.recipe[ik], info.name);
        });
      }
    });

    if (input.includeBase !== false && keys.length) {
      Object.keys(model.base || {}).forEach(function (ik) {
        var meta = model.ingredients[ik] || { name: ik.split('|')[0], unit: ik.split('|')[1] };
        add(ik, meta.name, meta.unit, model.base[ik], BASE_NAME);
      });
    }

    // Has this exact menu been made before?
    var exact = null;
    if (keys.length) {
      var matches = (model.menus || []).filter(function (mn) { return sameSet(mn.dishes, keys); });
      if (matches.length) {
        exact = { count: matches.length, dates: matches.map(function (m) { return m.date; }), used: false };
        if (input.useExact) {
          exact.used = true;
          lines = {}; order = [];
          var sums = {};
          matches.forEach(function (mn) {
            Object.keys(mn.perThaal).forEach(function (ik) { sums[ik] = (sums[ik] || 0) + mn.perThaal[ik]; });
          });
          Object.keys(sums).forEach(function (ik) {
            var meta = model.ingredients[ik] || { name: ik.split('|')[0], unit: ik.split('|')[1] };
            add(ik, meta.name, meta.unit, sums[ik] / matches.length, 'Past average of this exact menu');
          });
        }
      }
    }

    var outLines = order.map(function (ik) {
      var l = lines[ik];
      l.total = l.perThaal * thaals;
      return l;
    });
    outLines.sort(function (a, b) { return a.name.localeCompare(b.name); });

    return { thaals: thaals, dishes: dishInfo, lines: outLines, exact: exact };
  }

  return {
    ENGINE_VERSION: ENGINE_VERSION,
    BASE_KEY: BASE_KEY,
    BASE_NAME: BASE_NAME,
    FIELDS: FIELDS,
    FIELD_LABELS: FIELD_LABELS,
    UNIT_CHOICES: UNIT_CHOICES,
    COUNT_UNITS: COUNT_UNITS,
    normKey: normKey,
    titleCase: titleCase,
    splitDishes: splitDishes,
    parseNumber: parseNumber,
    parseThaals: parseThaals,
    normUnit: normUnit,
    parseQuantity: parseQuantity,
    formatQty: formatQty,
    smartNum: smartNum,
    parseDate: parseDate,
    parseMeal: parseMeal,
    autoMapColumns: autoMapColumns,
    rowsToMenus: rowsToMenus,
    parseDelimited: parseDelimited,
    dayFilesToMenus: dayFilesToMenus,
    nnlsRidge: nnlsRidge,
    train: train,
    emptyModel: emptyModel,
    confidenceOf: confidenceOf,
    resolveDishKey: resolveDishKey,
    ingKeyFor: ingKeyFor,
    listDishes: listDishes,
    suggestDishes: suggestDishes,
    didYouMean: didYouMean,
    calculate: calculate
  };
});
