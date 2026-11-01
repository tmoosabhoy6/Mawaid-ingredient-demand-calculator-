/* Mawaid Ingredient Calculator - user interface */
(function () {
  'use strict';

  const E = window.MawaidEngine;
  const S = window.MawaidStore;
  const $ = (id) => document.getElementById(id);
  const DRAFT_KEY = 'mawaid.draft';
  const SHEETJS_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';

  /* ================================================================== */
  /* helpers                                                             */
  /* ================================================================== */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function todayISO() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function prettyDate(iso, long) {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    if (isNaN(d)) return iso;
    return d.toLocaleDateString('en-GB', long
      ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }
      : { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }
  function prettyTime(isoTs) {
    if (!isoTs) return '';
    const d = new Date(isoTs);
    return isNaN(d) ? '' : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function qty(v, unit, whole) { return E.formatQty(v, unit, { whole: !!whole }); }
  function unique(arr) { return arr.filter((x, i) => arr.indexOf(x) === i); }
  function r6(v) { return v ? +(+v).toPrecision(6) : 0; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  let toastTimer = null;
  function toast(msg, ms) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms || 3200);
  }

  /** modal({title, body, actions:[{label, cls, onClick}]}) - onClick returning false keeps it open */
  function modal(opts) {
    const m = $('modal');
    $('modalTitle').textContent = opts.title || '';
    $('modalBody').innerHTML = opts.body || '';
    const acts = $('modalActions');
    acts.innerHTML = '';
    const close = () => { m.hidden = true; document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    (opts.actions || [{ label: 'OK', cls: 'primary' }]).forEach((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ' + (a.cls || '');
      b.textContent = a.label;
      b.addEventListener('click', () => { if (!a.onClick || a.onClick(close) !== false) close(); });
      acts.appendChild(b);
    });
    m.onclick = (e) => { if (e.target === m) close(); };
    document.addEventListener('keydown', onKey);
    m.hidden = false;
    if (opts.onOpen) opts.onOpen($('modalBody'));
    const focusEl = $('modalBody').querySelector('input, select, textarea') || acts.lastChild;
    if (focusEl) focusEl.focus();
    return close;
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(() => toast('Copied - paste it in WhatsApp or anywhere'));
    }
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Copied - paste it in WhatsApp or anywhere'); } catch (e) { toast('Could not copy'); }
    ta.remove();
    return Promise.resolve();
  }

  function listText(o) {
    const lines = [];
    lines.push('*' + o.meal + ' - ' + prettyDate(o.date) + '*');
    lines.push('Thaals: ' + o.thaals);
    lines.push('Menu: ' + o.dishes.join(', '));
    if (o.event) lines.push('Occasion: ' + o.event);
    lines.push('');
    o.ingredients.forEach((l) => lines.push('- ' + l.name + ': ' + qty(l.total, l.unit, true).text));
    if (o.notes) { lines.push(''); lines.push('Notes: ' + o.notes); }
    return lines.join('\n');
  }

  /* ================================================================== */
  /* state                                                               */
  /* ================================================================== */

  function newDraft() {
    return {
      id: uid(), date: todayISO(), meal: new Date().getHours() < 15 ? 'Lunch' : 'Dinner',
      thaalsInput: '', dishes: [], event: '', cook: '', notes: '',
      overrides: {}, removed: {}, extras: [],
      includeBase: true, useExact: false, view: 'combined',
      savedSig: null, savedAt: null, confirmedAt: null, originalDate: null
    };
  }

  const state = {
    model: S.localModel() || E.emptyModel(),
    manual: S.getManual(),
    draft: Object.assign(newDraft(), S.LS.get(DRAFT_KEY, {})),
    calc: null,
    lines: [],
    tab: 'calc',
    openEntries: {},
    openDishes: {},
    historyLimit: 40,
    historyNote: '',
    importData: null,
    importModel: null,
    importMenus: null,
    suggestIndex: -1,
    toastOnSync: false
  };

  function saveDraft() { S.LS.set(DRAFT_KEY, state.draft); }

  /* ================================================================== */
  /* calculation                                                         */
  /* ================================================================== */

  function compute() {
    const d = state.draft;
    const calc = E.calculate(state.model, state.manual, {
      dishes: d.dishes, thaals: d.thaalsInput, includeBase: d.includeBase, useExact: d.useExact
    });
    const t = calc.thaals;
    const lines = [];
    calc.lines.forEach((l) => {
      if (d.removed[l.key]) return;
      const ov = d.overrides[l.key];
      const per = ov != null ? ov : l.perThaal;
      lines.push({ key: l.key, name: l.name, unit: l.unit, perThaal: per, total: per * t, calcPerThaal: l.perThaal, edited: ov != null, extra: false, sources: l.sources });
    });
    d.extras.forEach((x) => {
      lines.push({ key: 'extra:' + x.id, extraId: x.id, name: x.name, unit: x.unit, perThaal: x.perThaal, total: x.perThaal * t, edited: false, extra: true, sources: [{ dish: 'Added by hand', perThaal: x.perThaal }] });
    });
    state.calc = calc;
    state.lines = lines;
  }

  function signature() {
    const d = state.draft, c = state.calc;
    return JSON.stringify([d.date, d.meal, c.thaals, c.dishes.map((x) => x.name), d.event, d.cook, d.notes,
      state.lines.map((l) => [l.name, l.unit, r6(l.perThaal)])]);
  }

  function buildEntry() {
    const d = state.draft, c = state.calc;
    const now = new Date().toISOString();
    return {
      id: d.id,
      meal: d.meal,
      thaals: c.thaals,
      thaalsInput: d.thaalsInput,
      dishes: c.dishes.map((x) => x.name),
      dishDetails: c.dishes.map((x) => ({ name: x.name, source: x.status, timesMadeBefore: x.count })),
      event: d.event.trim(),
      preparedBy: d.cook.trim(),
      notes: d.notes.trim(),
      includeCommon: d.includeBase,
      usedPastAverage: !!(c.exact && c.exact.used),
      ingredients: state.lines.map((l) => ({
        name: l.name, unit: l.unit,
        perThaal: r6(l.perThaal),
        total: +l.total.toFixed(3),
        edited: !!(l.edited || l.extra),
        fromDishes: unique(l.sources.map((s) => s.dish))
      })),
      formulas: { trainedAt: state.model.trainedAt || '', sample: !!state.model.sample },
      confirmedAt: d.confirmedAt || now,
      updatedAt: now
    };
  }

  /* ================================================================== */
  /* CALCULATE tab                                                       */
  /* ================================================================== */

  function renderForm() {
    const d = state.draft;
    $('fDate').value = d.date;
    $('fThaals').value = d.thaalsInput;
    $('fEvent').value = d.event;
    $('fCook').value = d.cook;
    $('fNotes').value = d.notes;
    if (d.event || d.cook || d.notes) $('moreDetails').open = true;
    setSeg('fMeal', d.meal);
    setSeg('viewSeg', d.view);
    renderThaalHint();
  }

  function setSeg(id, v) {
    $(id).querySelectorAll('button').forEach((b) => {
      const on = b.dataset.v === v;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }

  function renderThaalHint() {
    const t = E.parseThaals(state.draft.thaalsInput);
    $('thaalHint').textContent = /[+&]/.test(state.draft.thaalsInput) && t ? '= ' + E.smartNum(t) + ' thaals' : 'You can add groups, e.g. 74+15';
  }

  function update() {
    saveDraft();
    compute();
    renderChips();
    renderResult();
    renderConfirmBar();
  }

  function renderChips() {
    const c = state.calc;
    $('dishChips').innerHTML = c.dishes.map((x, i) => {
      const title = x.status === 'manual' ? 'Your own recipe'
        : x.status === 'unknown' ? 'No history for this dish'
          : 'Made ' + plural(x.count, 'time') + ' before';
      return '<span class="chip ' + (x.status === 'unknown' ? 'unknown' : '') + '" title="' + esc(title) + '">' +
        '<span class="conf conf-' + x.confidence + '"></span>' + esc(x.name) +
        '<button type="button" data-remove-dish="' + i + '" aria-label="Remove ' + esc(x.name) + '">&times;</button></span>';
    }).join('');
  }

  function dishSourcesText(l) {
    const names = unique(l.sources.map((s) => s.dish));
    return names.join(', ');
  }

  function renderResult() {
    const d = state.draft, c = state.calc, body = $('resultBody');
    const hasModel = Object.keys(state.model.dishes || {}).length || Object.keys(state.manual || {}).length;

    if (!c.dishes.length) {
      body.innerHTML = '<div class="empty"><p><b>Enter the number of thaals and add the dishes.</b></p><p>The quantity of every ingredient will appear here, per thaal and in total.</p>' +
        (hasModel ? '' : '<p>No formulas yet - <button type="button" class="linklike" data-goto="settings">import your history sheet</button> or <button type="button" class="linklike" data-goto="dishes">add a recipe by hand</button>.</p>') + '</div>';
      return;
    }

    let html = '';
    const notes = [];
    c.dishes.forEach((x) => {
      if (x.status === 'unknown') {
        notes.push('<div class="note warn"><span><b>' + esc(x.name) + '</b> has no history yet, so its ingredients are not included.' +
          (x.suggestion ? ' Did you mean <b>' + esc(x.suggestion) + '</b>?' : '') + '</span><span class="note-actions">' +
          (x.suggestion ? '<button type="button" class="btn small" data-replace-dish="' + esc(x.name) + '" data-with="' + esc(x.suggestion) + '">Use ' + esc(x.suggestion) + '</button>' : '') +
          '<button type="button" class="btn small" data-new-recipe="' + esc(x.name) + '">Add its recipe</button></span></div>');
      } else if (x.status === 'learned' && x.count === 1) {
        notes.push('<div class="note warn"><span><b>' + esc(x.name) + '</b> was made only once before' + (x.lastMade ? ' (' + esc(prettyDate(x.lastMade)) + ')' : '') + ', so its quantities are a rough estimate. Please check them.</span></div>');
      }
      if (x.status === 'learned' && x.pairedWith.length) {
        notes.push('<div class="note info"><span><b>' + esc(x.name) + '</b> has always been served with <b>' + esc(x.pairedWith.join(', ')) + '</b>, so the split between them is a best guess. Together the total is right.</span></div>');
      }
    });
    if (c.exact) {
      const last = c.exact.dates.filter(Boolean).sort().slice(-1)[0];
      notes.push('<div class="note ok"><span>This exact menu was made <b>' + plural(c.exact.count, 'time') + '</b> before' + (last ? ', last on ' + esc(prettyDate(last)) : '') + '.</span>' +
        '<label class="check" style="margin:0"><input type="checkbox" id="useExact" ' + (d.useExact ? 'checked' : '') + '> Use the average of those times</label></div>');
    }
    if (!c.thaals) notes.push('<div class="note info"><span>Enter the number of thaals to see the totals.</span></div>');
    if (notes.length) html += '<div class="notes">' + notes.join('') + '</div>';

    html += '<div class="print-head"><h2>' + esc(d.meal) + ' - ' + esc(prettyDate(d.date, true)) + '</h2><p>' + esc(c.thaals) + ' thaals &middot; ' + esc(c.dishes.map((x) => x.name).join(', ')) + '</p></div>';
    html += '<p class="summary-line"><span><b>' + esc(E.smartNum(c.thaals)) + '</b> thaals</span><span><b>' + c.dishes.length + '</b> ' + (c.dishes.length === 1 ? 'dish' : 'dishes') + '</span><span><b>' + state.lines.length + '</b> ingredients</span></p>';

    const baseCount = Object.keys(state.model.base || {}).length;
    if (baseCount && !(c.exact && c.exact.used)) {
      html += '<label class="check"><input type="checkbox" id="includeBase" ' + (d.includeBase ? 'checked' : '') + '> Include items served with every meal (' + plural(baseCount, 'item') + ')</label>';
    }

    html += d.view === 'bydish' ? renderByDish() : renderCombined();

    html += '<div class="result-actions">' +
      '<button type="button" class="btn" data-act="copy">Copy list</button>' +
      (navigator.share ? '<button type="button" class="btn" data-act="share">Share</button>' : '') +
      '<button type="button" class="btn" data-act="print">Print</button></div>';
    body.innerHTML = html;
  }

  function renderCombined() {
    const d = state.draft, c = state.calc;
    const t = c.thaals;
    let html = '<div class="table-wrap"><table><thead><tr><th>Ingredient</th><th class="num">Per thaal</th><th class="num">Total' + (t ? '<span class="wide-only"> (' + esc(E.smartNum(t)) + ' thaals)</span>' : '') + '</th><th aria-label="Remove"></th></tr></thead><tbody>';
    if (!state.lines.length) html += '<tr><td colspan="4" class="muted">No ingredients - add a recipe for the dishes, or add ingredients below.</td></tr>';
    state.lines.forEach((l) => {
      const tot = qty(l.total, l.unit, true);
      const per = qty(l.perThaal, l.unit);
      html += '<tr class="' + (l.edited ? 'edited' : l.extra ? 'extra' : '') + '">' +
        '<td class="name">' + esc(l.name) + '<span class="from">' + esc(dishSourcesText(l)) + '</span></td>' +
        '<td class="num">' + esc(per.text) + '</td>' +
        '<td class="num"><input class="qty-input" inputmode="decimal" data-qty="' + esc(l.key) + '" data-unit="' + esc(tot.unit) + '" value="' + esc(t ? tot.num : '') + '" ' + (t ? '' : 'disabled') + ' aria-label="Total ' + esc(l.name) + '"><span class="unit">' + esc(tot.unit) + '</span>' +
        (l.edited ? '<br><button type="button" class="reset" data-reset="' + esc(l.key) + '">changed - undo</button>' : '') + '</td>' +
        '<td><button type="button" class="row-btn" data-remove-line="' + esc(l.key) + '" title="Remove this ingredient" aria-label="Remove ' + esc(l.name) + '">&times;</button></td></tr>';
    });
    html += '</tbody></table></div>';

    const removed = c.lines.filter((l) => d.removed[l.key]);
    if (removed.length) {
      html += '<p class="removed-list">Removed: ' + removed.map((l) => esc(l.name) + ' <button type="button" class="reset" data-unremove="' + esc(l.key) + '">put back</button>').join(', ') + '</p>';
    }
    html += '<div class="add-row">' +
      '<input id="addIngName" list="ingredientList" placeholder="Add another ingredient" autocomplete="off">' +
      '<input id="addIngQty" inputmode="decimal" placeholder="Total qty">' +
      '<select id="addIngUnit">' + E.UNIT_CHOICES.map((u) => '<option>' + u + '</option>').join('') + '</select>' +
      '<button type="button" class="btn" data-act="add-ing">Add</button></div>';
    return html;
  }

  function renderByDish() {
    const c = state.calc, t = c.thaals;
    const groups = {}, order = [];
    c.lines.forEach((l) => l.sources.forEach((s) => {
      if (!groups[s.dish]) { groups[s.dish] = []; order.push(s.dish); }
      groups[s.dish].push({ name: l.name, unit: l.unit, perThaal: s.perThaal });
    }));
    state.draft.extras.forEach((x) => {
      if (!groups['Added by hand']) { groups['Added by hand'] = []; order.push('Added by hand'); }
      groups['Added by hand'].push({ name: x.name, unit: x.unit, perThaal: x.perThaal });
    });
    // keep the dish order the user typed
    const dishNames = c.dishes.map((x) => x.name);
    order.sort((a, b) => (dishNames.indexOf(a) + 1 || 99) - (dishNames.indexOf(b) + 1 || 99));
    let html = '<p class="muted small">Calculated amounts for each dish. Changes you make to totals are shown in "All together".</p>';
    order.forEach((dish) => {
      const info = c.dishes.find((x) => x.name === dish);
      html += '<div class="dish-block"><h3>' + (info ? '<span class="dot-inline conf-' + info.confidence + '"></span>' : '') + esc(dish) + '</h3>' +
        '<div class="table-wrap"><table><thead><tr><th>Ingredient</th><th class="num">Per thaal</th><th class="num">Total</th></tr></thead><tbody>' +
        groups[dish].sort((a, b) => a.name.localeCompare(b.name)).map((r) =>
          '<tr><td class="name">' + esc(r.name) + '</td><td class="num">' + esc(qty(r.perThaal, r.unit).text) + '</td><td class="num"><b>' + esc(t ? qty(r.perThaal * t, r.unit, true).text : '-') + '</b></td></tr>').join('') +
        '</tbody></table></div></div>';
    });
    c.dishes.filter((x) => x.status === 'unknown').forEach((x) => {
      html += '<div class="dish-block"><h3><span class="dot-inline conf-none"></span>' + esc(x.name) + '</h3><p class="muted">No recipe yet.</p></div>';
    });
    return html;
  }

  function renderConfirmBar() {
    const d = state.draft, c = state.calc;
    const btn = $('confirmBtn');
    if (!c.dishes.length || !c.thaals) {
      $('confirmSummary').innerHTML = !c.thaals && !c.dishes.length ? 'Add thaals and dishes' : !c.thaals ? 'Add the number of thaals' : 'Add at least one dish';
      btn.disabled = true;
      btn.textContent = 'Confirm & save';
      return;
    }
    const saved = d.savedSig && d.savedSig === signature();
    $('confirmSummary').innerHTML = '<b>' + esc(d.meal) + '</b> &middot; ' + esc(prettyDate(d.date)) + ' &middot; <b>' + esc(E.smartNum(c.thaals)) + '</b> thaals<br>' +
      (saved ? '<span class="saved">&#10003; Saved' + (d.savedAt ? ' ' + esc(prettyTime(d.savedAt)) : '') + '</span>'
        : d.savedSig ? 'Changed since it was saved' : 'Not saved yet');
    btn.disabled = !!saved;
    btn.textContent = saved ? 'Saved' : d.savedSig ? 'Save changes' : 'Confirm & save';
  }

  /* ---------- dish entry & suggestions ---------- */

  function canonicalDishName(name) {
    const key = E.resolveDishKey(state.model, state.manual, name);
    const m = state.manual[key];
    if (m && !m.deleted) return m.name;
    if (state.model.dishes[key]) return state.model.dishes[key].name;
    return E.titleCase(name);
  }

  function addDishes(text) {
    const names = E.splitDishes(text);
    if (!names.length) return;
    const keys = state.draft.dishes.map((n) => E.resolveDishKey(state.model, state.manual, n));
    let added = 0;
    names.forEach((n) => {
      const k = E.resolveDishKey(state.model, state.manual, n);
      if (keys.indexOf(k) >= 0) return;
      keys.push(k);
      state.draft.dishes.push(canonicalDishName(n));
      added++;
    });
    if (!added) toast('Already in the menu');
    $('fDish').value = '';
    hideSuggest();
    update();
  }

  function renderSuggest() {
    const input = $('fDish'), list = $('dishSuggest');
    const text = input.value;
    const taken = state.draft.dishes.map((n) => E.resolveDishKey(state.model, state.manual, n));
    const parts = E.splitDishes(text);
    const last = /[+,]\s*$/.test(text) ? '' : (parts[parts.length - 1] || '');
    if (!last && document.activeElement !== input) { hideSuggest(); return; }
    let items = E.suggestDishes(state.model, state.manual, last, 8).filter((x) => taken.indexOf(x.key) < 0);
    const exact = items.some((x) => E.normKey(x.name) === E.normKey(last));
    const rows = items.map((x) => ({ name: x.name, meta: x.manual && !x.learned ? 'your recipe' : 'made ' + plural(x.count, 'time') }));
    if (last && !exact) rows.push({ name: E.titleCase(last), meta: 'new dish', isNew: true });
    if (!rows.length) { hideSuggest(); return; }
    state.suggestRows = rows;
    if (state.suggestIndex >= rows.length) state.suggestIndex = rows.length - 1;
    list.innerHTML = rows.map((r, i) => '<li role="option" data-i="' + i + '" class="' + (i === state.suggestIndex ? 'active' : '') + '"><span>' + (r.isNew ? 'Add &ldquo;' + esc(r.name) + '&rdquo;' : esc(r.name)) + '</span><span class="meta">' + esc(r.meta) + '</span></li>').join('');
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }
  function hideSuggest() {
    $('dishSuggest').hidden = true;
    $('fDish').setAttribute('aria-expanded', 'false');
    state.suggestIndex = -1;
  }
  function pickSuggestion(i) {
    const r = state.suggestRows && state.suggestRows[i];
    if (!r) return;
    const text = $('fDish').value;
    const parts = E.splitDishes(text);
    if (!/[+,]\s*$/.test(text)) parts.pop();
    parts.push(r.name);
    addDishes(parts.join(' + '));
    $('fDish').focus();
  }

  /* ---------- confirm ---------- */

  function findSameMeal(date, meal, id) {
    const day = S.getDays()[date];
    return day ? (day.entries || []).find((e) => e.meal === meal && e.id !== id) : null;
  }

  function onConfirm() {
    compute();
    const d = state.draft, c = state.calc;
    if (!d.date) return toast('Choose a date');
    if (!c.thaals) return toast('Enter the number of thaals');
    if (!c.dishes.length) return toast('Add at least one dish');
    const unknown = c.dishes.filter((x) => x.status === 'unknown');
    const existing = findSameMeal(d.date, d.meal, d.id);
    let body = '<dl class="kv" style="display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:0">' +
      '<dt class="muted">Date</dt><dd style="margin:0"><b>' + esc(prettyDate(d.date, true)) + '</b></dd>' +
      '<dt class="muted">Meal</dt><dd style="margin:0"><b>' + esc(d.meal) + '</b></dd>' +
      '<dt class="muted">Thaals</dt><dd style="margin:0"><b>' + esc(E.smartNum(c.thaals)) + '</b>' + (/[+&]/.test(d.thaalsInput) ? ' (' + esc(d.thaalsInput) + ')' : '') + '</dd>' +
      '<dt class="muted">Menu</dt><dd style="margin:0">' + esc(c.dishes.map((x) => x.name).join(', ')) + '</dd>' +
      '<dt class="muted">Ingredients</dt><dd style="margin:0">' + state.lines.length + '</dd></dl>';
    if (unknown.length) body += '<div class="note warn" style="margin-top:12px">No ingredients are included for: <b>' + esc(unknown.map((x) => x.name).join(', ')) + '</b>.</div>';
    if (!S.canWrite()) body += '<p class="muted small" style="margin-top:12px">GitHub is not connected yet, so this is saved on this device and will be sent to the repository once a token is added in Settings.</p>';

    if (existing) {
      body += '<div class="note info" style="margin-top:12px">A <b>' + esc(existing.meal) + '</b> for this date is already saved: ' + esc((existing.dishes || []).join(', ')) + ' (' + esc(existing.thaals) + ' thaals).</div>';
      modal({
        title: 'Save this menu?', body: body,
        actions: [
          { label: 'Cancel' },
          { label: 'Save as an extra meal', onClick: () => doSave() },
          { label: 'Replace it', cls: 'primary', onClick: () => doSave(existing.id) }
        ]
      });
    } else {
      modal({ title: 'Save this menu?', body: body, actions: [{ label: 'Back' }, { label: 'Confirm & save', cls: 'primary', onClick: () => doSave() }] });
    }
  }

  function doSave(replaceId) {
    const d = state.draft;
    if (replaceId && replaceId !== d.id) {
      if (d.originalDate) S.deleteEntry(d.originalDate, d.id); // the entry being edited is merged into the replaced one
      d.id = replaceId;
      d.originalDate = d.date;
    }
    if (d.originalDate && d.originalDate !== d.date) S.deleteEntry(d.originalDate, d.id); // date was changed
    compute();
    const entry = buildEntry();
    d.confirmedAt = entry.confirmedAt;
    d.savedAt = entry.updatedAt;
    d.savedSig = signature();
    d.originalDate = d.date;
    saveDraft();
    state.toastOnSync = S.canWrite();
    S.saveEntry(d.date, entry);
    toast(S.canWrite() ? 'Saved. Sending to GitHub...' : 'Saved on this device');
    renderConfirmBar();
  }

  function startNewMenu() {
    const d = state.draft;
    const unsaved = d.dishes.length && d.savedSig !== signature();
    const go = () => { state.draft = newDraft(); saveDraft(); renderForm(); update(); $('fThaals').focus(); };
    if (unsaved) {
      modal({ title: 'Start a new menu?', body: '<p>The current menu has not been saved. It will be cleared.</p>', actions: [{ label: 'Cancel' }, { label: 'Clear it', cls: 'primary', onClick: go }] });
    } else go();
  }

  function parseTotalInput(text, displayUnit, line) {
    const hasLetters = /[a-z]/i.test(text);
    const q = E.parseQuantity(text, hasLetters ? undefined : displayUnit);
    if (!q || q.value < 0) return { error: 'Please type a number' };
    if (q.unit !== line.unit) return { error: line.name + ' is measured in ' + line.unit };
    return { value: q.value };
  }

  /* ================================================================== */
  /* HISTORY tab                                                         */
  /* ================================================================== */

  function entryMatches(e, date, q) {
    if (!q) return true;
    const hay = E.normKey([date, prettyDate(date, true), e.meal, (e.dishes || []).join(' '), e.event, e.preparedBy, e.notes].join(' '));
    return q.split(' ').every((w) => hay.indexOf(w) >= 0);
  }

  function renderHistory() {
    const days = S.getDays();
    const pend = S.pendingIds();
    const q = E.normKey($('historySearch').value);
    const dates = Object.keys(days).sort().reverse();
    let shown = 0, html = '';
    for (const date of dates) {
      const entries = (days[date].entries || []).filter((e) => entryMatches(e, date, q));
      if (!entries.length) continue;
      if (shown >= state.historyLimit) { html += '<button type="button" class="btn" style="width:100%" data-act="more-history">Show older days</button>'; break; }
      shown++;
      const totalThaals = entries.reduce((a, e) => a + (+e.thaals || 0), 0);
      html += '<div class="day"><div class="day-head"><h3>' + esc(prettyDate(date, true)) + '</h3><span class="muted small">' + plural(entries.length, 'meal') + ' &middot; ' + esc(E.smartNum(totalThaals)) + ' thaals</span></div>';
      entries.forEach((e) => {
        const open = !!state.openEntries[e.id];
        const mealCls = /lunch/i.test(e.meal) ? 'lunch' : /dinner/i.test(e.meal) ? 'dinner' : '';
        html += '<div class="entry ' + (open ? 'open' : '') + '">' +
          '<button type="button" class="entry-head" data-entry="' + esc(e.id) + '" aria-expanded="' + open + '">' +
          '<svg class="chev" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>' +
          '<div class="entry-main"><div class="entry-title"><span class="pill ' + mealCls + '">' + esc(e.meal) + '</span> ' + esc((e.dishes || []).join(', ')) + '</div>' +
          '<div class="entry-sub">' + esc([e.event, e.preparedBy ? 'by ' + e.preparedBy : '', plural((e.ingredients || []).length, 'ingredient')].filter(Boolean).join(' · ')) +
          (pend[e.id] ? ' <span class="pill pending">waiting to sync</span>' : '') + '</div></div>' +
          '<div class="thaal-count">' + esc(E.smartNum(+e.thaals || 0)) + '<small>thaals</small></div></button>';
        if (open) html += renderEntryBody(e, date);
        html += '</div>';
      });
      html += '</div>';
    }
    if (!shown) {
      html = '<div class="card empty">' + (q ? '<p><b>Nothing matches your search.</b></p>' : '<p><b>Nothing saved yet.</b></p><p>Menus you confirm on the Calculate tab are listed here, newest first.</p>') + '</div>';
    }
    $('historyList').innerHTML = html;
    $('historyStatus').textContent = state.historyNote;
  }

  function renderEntryBody(e, date) {
    let html = '<div class="entry-body"><dl class="kv">' +
      '<dt>Thaals</dt><dd><b>' + esc(E.smartNum(+e.thaals || 0)) + '</b>' + (e.thaalsInput && /[+&]/.test(e.thaalsInput) ? ' (' + esc(e.thaalsInput) + ')' : '') + '</dd>' +
      (e.event ? '<dt>Occasion</dt><dd>' + esc(e.event) + '</dd>' : '') +
      (e.preparedBy ? '<dt>Prepared by</dt><dd>' + esc(e.preparedBy) + '</dd>' : '') +
      (e.notes ? '<dt>Notes</dt><dd>' + esc(e.notes) + '</dd>' : '') +
      '<dt>Saved</dt><dd>' + esc(prettyTime(e.updatedAt || e.confirmedAt)) + '</dd></dl>';
    html += '<div class="table-wrap"><table><thead><tr><th>Ingredient</th><th class="num">Per thaal</th><th class="num">Total</th></tr></thead><tbody>' +
      (e.ingredients || []).map((l) => '<tr class="' + (l.edited ? 'edited' : '') + '"><td class="name">' + esc(l.name) + '</td><td class="num">' + esc(qty(l.perThaal, l.unit).text) + '</td><td class="num"><b>' + esc(qty(l.total, l.unit, true).text) + '</b></td></tr>').join('') +
      '</tbody></table></div>' +
      '<div class="result-actions">' +
      '<button type="button" class="btn" data-hist="edit" data-date="' + esc(date) + '" data-id="' + esc(e.id) + '">Edit</button>' +
      '<button type="button" class="btn" data-hist="reuse" data-date="' + esc(date) + '" data-id="' + esc(e.id) + '">Use again</button>' +
      '<button type="button" class="btn" data-hist="copy" data-date="' + esc(date) + '" data-id="' + esc(e.id) + '">Copy list</button>' +
      '<button type="button" class="btn danger ghost" data-hist="delete" data-date="' + esc(date) + '" data-id="' + esc(e.id) + '">Delete</button></div></div>';
    return html;
  }

  function findEntry(date, id) {
    const day = S.getDays()[date];
    return day ? (day.entries || []).find((e) => e.id === id) : null;
  }

  /** Rebuild a draft that reproduces a saved entry exactly */
  function draftFromEntry(e, date, asNew) {
    const d = newDraft();
    Object.assign(d, {
      id: asNew ? uid() : e.id,
      date: asNew ? todayISO() : date,
      meal: e.meal,
      thaalsInput: e.thaalsInput || String(e.thaals),
      dishes: (e.dishes || []).slice(),
      event: asNew ? '' : (e.event || ''),
      cook: asNew ? '' : (e.preparedBy || ''),
      notes: asNew ? '' : (e.notes || ''),
      includeBase: e.includeCommon !== false,
      useExact: !!e.usedPastAverage,
      originalDate: asNew ? null : date,
      confirmedAt: asNew ? null : e.confirmedAt,
      savedAt: asNew ? null : e.updatedAt
    });
    const calc = E.calculate(state.model, state.manual, { dishes: d.dishes, thaals: d.thaalsInput, includeBase: d.includeBase, useExact: d.useExact });
    const byName = {};
    calc.lines.forEach((l) => { byName[l.name.toLowerCase() + '|' + l.unit] = l; });
    const seen = {};
    (e.ingredients || []).forEach((ing) => {
      const l = byName[String(ing.name).toLowerCase() + '|' + ing.unit];
      if (l && !seen[l.key]) {
        seen[l.key] = true;
        if (Math.abs(l.perThaal - ing.perThaal) > 1e-5 * Math.max(1e-9, ing.perThaal)) d.overrides[l.key] = ing.perThaal;
      } else {
        d.extras.push({ id: uid(), name: ing.name, unit: ing.unit, perThaal: ing.perThaal });
      }
    });
    calc.lines.forEach((l) => { if (!seen[l.key]) d.removed[l.key] = true; });
    return d;
  }

  function loadIntoCalculator(d, markSaved) {
    const cur = state.draft;
    compute();
    const unsaved = cur.dishes.length && cur.savedSig !== signature();
    const go = () => {
      state.draft = d;
      compute();
      if (markSaved) d.savedSig = signature();
      saveDraft();
      renderForm();
      update();
      switchTab('calc');
      window.scrollTo(0, 0);
    };
    if (unsaved) {
      modal({ title: 'Replace the current menu?', body: '<p>The menu on the Calculate tab has not been saved. It will be replaced.</p>', actions: [{ label: 'Cancel' }, { label: 'Replace', cls: 'primary', onClick: go }] });
    } else go();
  }

  function refreshHistory(manual) {
    if (!S.canRead()) {
      state.historyNote = 'Showing menus saved on this device. Connect GitHub in Settings to see the shared history.';
      renderHistory();
      return Promise.resolve();
    }
    state.historyNote = 'Loading from GitHub...';
    if (state.tab === 'history') renderHistory();
    return S.refreshHistory().then((r) => {
      state.historyNote = 'Up to date with GitHub (' + plural(r.files, 'day') + ') - ' + prettyTime(new Date().toISOString());
      if (manual) toast('History refreshed');
    }).catch((err) => {
      state.historyNote = 'Could not load from GitHub: ' + err.message + ' Showing what is saved on this device.';
    }).then(() => { if (state.tab === 'history') renderHistory(); });
  }

  /* ================================================================== */
  /* DISHES tab                                                          */
  /* ================================================================== */

  function renderDishes() {
    const q = E.normKey($('dishSearch').value);
    const all = E.listDishes(state.model, state.manual)
      .filter((x) => !q || E.normKey(x.name).indexOf(q) >= 0)
      .sort((a, b) => a.name.localeCompare(b.name));
    const n = E.listDishes(state.model, state.manual).length;
    $('dishesStatus').textContent = n ? plural(n, 'dish', 'dishes') + '. Tap one to see its ingredients per thaal.' : '';
    if (!all.length) {
      $('dishList').innerHTML = '<div class="card empty">' + (q ? '<p><b>No dish with that name.</b></p><p><button type="button" class="btn primary" data-new-recipe="' + esc($('dishSearch').value) + '">Add &ldquo;' + esc($('dishSearch').value) + '&rdquo;</button></p>' : '<p><b>No dishes yet.</b></p><p>Import your history in Settings, or add a recipe with &ldquo;+ New dish&rdquo;.</p>') + '</div>';
      return;
    }
    $('dishList').innerHTML = all.map((x) => {
      const open = !!state.openDishes[x.key];
      const conf = x.manual ? 'manual' : E.confidenceOf(x.count);
      const confLabel = { manual: 'your recipe', high: 'reliable', medium: 'fair', low: 'rough', none: '' }[conf];
      const sub = x.learned ? 'Made ' + plural(x.count, 'time') + (x.lastMade ? ' · last ' + prettyDate(x.lastMade) : '') : 'Added by hand';
      return '<div class="dish-row ' + (open ? 'open' : '') + '"><button type="button" class="dish-row-head" data-dish="' + esc(x.key) + '" aria-expanded="' + open + '">' +
        '<svg class="chev" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>' +
        '<div class="dish-main"><div class="dish-title">' + esc(x.name) + '</div><div class="dish-sub">' + esc(sub) + '</div></div>' +
        (confLabel ? '<span class="pill ' + conf + '">' + confLabel + '</span>' : '') + '</button>' +
        (open ? renderDishBody(x) : '') + '</div>';
    }).join('');
  }

  function renderDishBody(x) {
    const t = state.calc && state.calc.thaals ? state.calc.thaals : 100;
    const r = E.calculate(state.model, state.manual, { dishes: [x.name], thaals: t, includeBase: false });
    const learned = state.model.dishes[x.key];
    let html = '<div class="dish-body">';
    if (x.manual && learned) html += '<div class="note info" style="margin-bottom:10px">Your own recipe is used instead of the one learned from history.</div>';
    if (learned && learned.pairedWith && learned.pairedWith.length) html += '<div class="note info" style="margin-bottom:10px">Always served with ' + esc(learned.pairedWith.join(', ')) + ' - the split between them is a best guess.</div>';
    if (r.lines.length) {
      html += '<div class="table-wrap"><table><thead><tr><th>Ingredient</th><th class="num">Per thaal</th><th class="num">For ' + esc(E.smartNum(t)) + ' thaals</th></tr></thead><tbody>' +
        r.lines.map((l) => '<tr><td class="name">' + esc(l.name) + '</td><td class="num"><b>' + esc(qty(l.perThaal, l.unit).text) + '</b></td><td class="num">' + esc(qty(l.total, l.unit, true).text) + '</td></tr>').join('') +
        '</tbody></table></div>';
    } else html += '<p class="muted">No ingredients recorded.</p>';
    if (learned && learned.dates && learned.dates.length) {
      html += '<p class="muted small">Made on: ' + esc(learned.dates.slice(-6).reverse().map((dt) => prettyDate(dt)).join(', ')) + (learned.dates.length > 6 ? ' ...' : '') + '</p>';
    }
    html += '<div class="result-actions">' +
      '<button type="button" class="btn primary" data-dish-act="add" data-key="' + esc(x.key) + '">Add to menu</button>' +
      '<button type="button" class="btn" data-dish-act="edit" data-key="' + esc(x.key) + '">' + (x.manual ? 'Edit recipe' : 'Correct this recipe') + '</button>' +
      (x.manual ? '<button type="button" class="btn danger ghost" data-dish-act="unmanual" data-key="' + esc(x.key) + '">' + (learned ? 'Go back to learned recipe' : 'Delete dish') + '</button>' : '') +
      '</div></div>';
    return html;
  }

  function editorRow(r) {
    r = r || { name: '', qty: '', unit: 'kg' };
    return '<div class="edit-row">' +
      '<input class="er-name" list="ingredientList" placeholder="Ingredient" value="' + esc(r.name) + '">' +
      '<input class="er-qty" inputmode="decimal" placeholder="Qty" value="' + esc(r.qty) + '">' +
      '<select class="er-unit">' + E.UNIT_CHOICES.map((u) => '<option' + (u === r.unit ? ' selected' : '') + '>' + u + '</option>').join('') + '</select>' +
      '<button type="button" class="row-btn er-del" aria-label="Remove row">&times;</button></div>';
  }

  function openDishEditor(key, presetName) {
    const man = key && state.manual[key] && !state.manual[key].deleted ? state.manual[key] : null;
    const learned = key ? state.model.dishes[key] : null;
    const name = man ? man.name : learned ? learned.name : E.titleCase(presetName || '');
    let rows = [];
    if (man) rows = man.ingredients.map((i) => ({ name: i.name, qty: i.qty, unit: E.UNIT_CHOICES.indexOf(i.unit) >= 0 ? i.unit : 'kg' }));
    else if (learned) {
      rows = Object.keys(learned.recipe).map((ik) => {
        const meta = state.model.ingredients[ik] || { name: ik.split('|')[0], unit: ik.split('|')[1] };
        const f = qty(learned.recipe[ik], meta.unit);
        return { name: meta.name, qty: f.num, unit: f.unit };
      }).sort((a, b) => a.name.localeCompare(b.name));
    }
    if (!rows.length) rows = [null, null, null];
    const body = '<label class="field"><span class="label">Dish name</span><input id="edName" value="' + esc(name) + '"></label>' +
      '<p class="muted small" style="margin:0">Quantities are for <b>one thaal</b>.' + (learned && !man ? ' Starting from what the history shows - correct anything that looks wrong.' : '') + '</p>' +
      '<div class="edit-rows" id="edRows">' + rows.map(editorRow).join('') + '</div>' +
      '<button type="button" class="btn small" id="edAdd">+ Add ingredient</button>';
    modal({
      title: man ? 'Edit recipe' : learned ? 'Correct recipe' : 'New dish',
      body: body,
      onOpen: (el) => {
        el.querySelector('#edAdd').addEventListener('click', () => {
          el.querySelector('#edRows').insertAdjacentHTML('beforeend', editorRow());
          const all = el.querySelectorAll('.er-name');
          all[all.length - 1].focus();
        });
        el.addEventListener('click', (ev) => { if (ev.target.closest('.er-del')) ev.target.closest('.edit-row').remove(); });
      },
      actions: [
        { label: 'Cancel' },
        {
          label: 'Save recipe', cls: 'primary', onClick: () => {
            const el = $('modalBody');
            const newName = el.querySelector('#edName').value.trim();
            if (!newName) { toast('Enter the dish name'); return false; }
            const ingredients = [];
            let bad = '';
            el.querySelectorAll('.edit-row').forEach((row) => {
              const n = row.querySelector('.er-name').value.trim();
              const q = row.querySelector('.er-qty').value.trim();
              const u = row.querySelector('.er-unit').value;
              if (!n && !q) return;
              if (!n || !(E.parseNumber(q) > 0)) { bad = n || 'a row'; return; }
              ingredients.push({ name: E.titleCase(n), qty: E.parseNumber(q), unit: u });
            });
            if (bad) { toast('Check the quantity for ' + bad); return false; }
            if (!ingredients.length) { toast('Add at least one ingredient'); return false; }
            const newKey = E.resolveDishKey(state.model, state.manual, newName);
            if (man && key !== newKey) S.saveManual(key, { name: man.name, ingredients: [], deleted: true });
            S.saveManual(newKey, { name: newName, ingredients: ingredients });
            state.manual = S.getManual();
            state.openDishes[newKey] = true;
            toast('Recipe saved');
            refreshAfterRecipeChange();
          }
        }
      ]
    });
  }

  function refreshAfterRecipeChange() {
    fillIngredientList();
    update();
    if (state.tab === 'dishes') renderDishes();
  }

  /* ================================================================== */
  /* SETTINGS tab                                                        */
  /* ================================================================== */

  function renderSettings() {
    const c = S.config();
    $('ghOwner').value = c.owner || '';
    $('ghRepo').value = c.repo || '';
    $('ghBranch').value = c.branch || 'main';
    $('ghToken').value = c.token || '';
    renderModelInfo();
    renderDeviceInfo();
  }

  function renderModelInfo() {
    const m = state.model, s = m.stats || {};
    const imported = S.LS.get('mawaid.model', null);
    if (!m.trainedAt) {
      $('modelInfo').innerHTML = '<p class="muted">No formulas yet. Import your menu history above.</p>';
      return;
    }
    $('modelInfo').innerHTML =
      (m.sample ? '<div class="note warn" style="margin-bottom:10px">These are sample formulas from made-up data.</div>' : '') +
      '<div class="stat-grid">' +
      '<div class="stat"><b>' + (s.menus || 0) + '</b><span>past menus</span></div>' +
      '<div class="stat"><b>' + (s.dishes || 0) + '</b><span>dishes</span></div>' +
      '<div class="stat"><b>' + (s.ingredients || 0) + '</b><span>ingredients</span></div>' +
      (s.avgError != null ? '<div class="stat"><b>&plusmn;' + (s.avgError * 100).toFixed(0) + '%</b><span>avg. difference from history</span></div>' : '') +
      '</div>' +
      '<p class="muted small">History from ' + esc(prettyDate(s.firstDate) || '?') + ' to ' + esc(prettyDate(s.lastDate) || '?') + '. Worked out ' + esc(prettyTime(m.trainedAt)) + (m.source ? ' from ' + esc(m.source) : '') + '.</p>' +
      (imported && imported.trainedAt === m.trainedAt ? '<p class="small">These formulas were imported on this device. <button type="button" class="linklike" data-act="drop-local-model">Use the repository version instead</button></p>' : '');
  }

  function renderDeviceInfo() {
    const st = S.status();
    const days = Object.keys(S.getDays()).length;
    const stateText = {
      local: 'GitHub is not connected - everything is kept on this device.',
      synced: 'Everything is saved to GitHub.',
      pending: plural(st.pending, 'change') + ' waiting to be sent to GitHub (retries every 30 seconds).',
      syncing: 'Sending to GitHub...',
      error: 'Could not reach GitHub: ' + st.error
    }[st.state];
    $('deviceInfo').innerHTML = '<p>' + esc(stateText) + '</p><p class="muted small">' + plural(days, 'day') + ' of menus stored on this device' + (st.lastSync ? ' · last sync ' + esc(prettyTime(st.lastSync)) : '') + '.</p>';
  }

  /* ---------- import ---------- */

  function loadSheetJS() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SHEETJS_URL;
      s.onload = () => resolve(window.XLSX);
      s.onerror = () => reject(new Error('Could not load the Excel reader (needs internet). Save the sheet as CSV and try again.'));
      document.head.appendChild(s);
    });
  }

  function setImportStatus(msg, cls) {
    const el = $('importStatus');
    el.textContent = msg;
    el.className = 'status-text ' + (cls || '');
  }

  function readImport() {
    const file = $('importFile').files[0];
    const pasted = $('importPaste').value;
    state.importModel = null;
    $('importResult').innerHTML = '';
    if (!file && !pasted.trim()) { setImportStatus('Choose a file or paste some rows first.', 'err'); return; }
    setImportStatus('Reading...');
    let p;
    if (file && /\.(xlsx|xls)$/i.test(file.name)) {
      p = Promise.all([loadSheetJS(), file.arrayBuffer()]).then(([XLSX, buf]) => {
        const wb = XLSX.read(buf, { type: 'array', cellDates: true });
        return wb.SheetNames.map((n) => ({ name: n, rows: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '', raw: true }) }))
          .filter((s) => s.rows.length > 1);
      });
    } else if (file) {
      p = file.text().then((t) => [{ name: file.name, rows: E.parseDelimited(t) }]);
    } else {
      p = Promise.resolve([{ name: 'Pasted rows', rows: E.parseDelimited(pasted) }]);
    }
    p.then((sheets) => {
      if (!sheets.length) throw new Error('No rows found.');
      state.importData = { name: file ? file.name : 'pasted rows', sheets: sheets, sheet: 0 };
      sheets.forEach((s) => { s.headerAt = findHeaderRow(s.rows); s.mapping = E.autoMapColumns(s.rows[s.headerAt].map(String)); });
      setImportStatus('Found ' + plural(sheets.length, 'sheet') + '. Check the columns below, then press Analyse.', 'ok');
      renderMapping();
    }).catch((e) => setImportStatus(e.message, 'err'));
  }

  function findHeaderRow(rows) {
    for (let i = 0; i < Math.min(rows.length, 30); i++) {
      const m = E.autoMapColumns((rows[i] || []).map(String));
      if (m.ingredient != null && m.qty != null) return i;
    }
    return 0;
  }

  function colName(i) { let s = ''; i++; while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; }

  function renderMapping() {
    const imp = state.importData;
    if (!imp) { $('importMapping').innerHTML = ''; return; }
    const all = imp.sheet === 'all';
    const sh = imp.sheets[all ? 0 : imp.sheet];
    const header = sh.rows[sh.headerAt] || [];
    const width = Math.max.apply(null, sh.rows.slice(sh.headerAt, sh.headerAt + 30).map((r) => r.length).concat([header.length]));
    const opts = (sel) => '<option value="">(none)</option>' + Array.from({ length: width }, (_, i) =>
      '<option value="' + i + '"' + (sel === i ? ' selected' : '') + '>' + colName(i) + ': ' + esc(String(header[i] == null ? '' : header[i]).slice(0, 30)) + '</option>').join('');
    let html = '';
    if (imp.sheets.length > 1) {
      html += '<label class="field" style="margin-top:14px"><span class="label">Sheet</span><select id="impSheet">' +
        imp.sheets.map((s, i) => '<option value="' + i + '"' + (imp.sheet === i ? ' selected' : '') + '>' + esc(s.name) + ' (' + (s.rows.length - 1) + ' rows)</option>').join('') +
        '<option value="all"' + (all ? ' selected' : '') + '>All sheets (each read automatically)</option></select></label>';
    }
    if (!all) {
      html += '<div class="map-grid">' +
        '<label class="field"><span class="label">Header row</span><input id="impHeader" type="number" min="1" value="' + (sh.headerAt + 1) + '"></label>' +
        E.FIELDS.map((f) => '<label class="field"><span class="label">' + esc(E.FIELD_LABELS[f]) + (f === 'ingredient' || f === 'qty' ? ' *' : '') + '</span><select data-map="' + f + '">' + opts(sh.mapping[f]) + '</select></label>').join('') +
        '</div>';
    } else html += '<div style="height:10px"></div>';
    html += '<div class="map-grid">' +
      '<label class="field"><span class="label">Unit when none is given</span><select id="impUnit">' + E.UNIT_CHOICES.map((u) => '<option' + (u === 'kg' ? ' selected' : '') + '>' + u + '</option>').join('') + '</select></label>' +
      '<label class="field"><span class="label">Meal when none is given</span><select id="impMeal"><option>Dinner</option><option>Lunch</option></select></label></div>';
    if (!all) {
      const prev = sh.rows.slice(sh.headerAt, sh.headerAt + 7);
      html += '<p class="muted small">First rows of the sheet:</p><div class="table-wrap"><table class="mini"><tbody>' +
        prev.map((r, ri) => '<tr>' + Array.from({ length: Math.min(width, 12) }, (_, i) => (ri === 0 ? '<th>' : '<td>') + esc(fmtCell(r[i])) + (ri === 0 ? '</th>' : '</td>')).join('') + '</tr>').join('') +
        '</tbody></table></div>';
    }
    html += '<label class="check" style="margin-top:12px"><input type="checkbox" id="impConfirmed"> Also learn from menus already confirmed in this app</label>' +
      '<div class="actions"><button type="button" class="btn primary" data-act="analyse">Analyse</button></div>';
    $('importMapping').innerHTML = html;
  }

  function fmtCell(v) {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return String(v == null ? '' : v).slice(0, 40);
  }

  function analyseImport() {
    const imp = state.importData;
    if (!imp) return;
    const opts = { defaultUnit: $('impUnit').value, defaultMeal: $('impMeal').value };
    let menus = [], warnings = [];
    const sheets = imp.sheet === 'all' ? imp.sheets : [imp.sheets[imp.sheet]];
    sheets.forEach((sh) => {
      const mapping = imp.sheet === 'all' ? E.autoMapColumns(sh.rows[sh.headerAt].map(String)) : sh.mapping;
      if (mapping.ingredient == null || mapping.qty == null) { warnings.push(sh.name + ': no Ingredient / Quantity column - skipped'); return; }
      const r = E.rowsToMenus(sh.rows.slice(sh.headerAt), mapping, opts);
      menus = menus.concat(r.menus);
      warnings = warnings.concat(r.warnings.map((w) => (sheets.length > 1 ? sh.name + ' ' : '') + w));
    });
    state.importMenus = menus.slice();
    if ($('impConfirmed').checked) menus = menus.concat(E.dayFilesToMenus(Object.values(S.getDays())));
    if (!menus.length) {
      $('importResult').innerHTML = '<div class="note warn">No menus found. Check that the Ingredient, Quantity, Thaal count and Menu columns are chosen correctly.</div>' + warnList(warnings);
      return;
    }
    setImportStatus('Working out the formulas...');
    setTimeout(() => {
      const model = E.train(menus, { aliases: state.model.aliases, source: imp.name });
      state.importModel = model;
      setImportStatus('Done.', 'ok');
      renderImportResult(warnings);
    }, 30);
  }

  function warnList(w) {
    if (!w.length) return '';
    return '<details class="help"><summary>' + plural(w.length, 'row') + ' could not be used</summary><ul class="small">' + w.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul></details>';
  }

  function renderImportResult(warnings) {
    const m = state.importModel, s = m.stats;
    const dishes = Object.values(m.dishes).sort((a, b) => b.count - a.count);
    const weak = dishes.filter((d) => d.count < 2).length;
    $('importResult').innerHTML =
      '<h3 style="margin-top:18px">Result</h3>' +
      '<div class="stat-grid">' +
      '<div class="stat"><b>' + s.menus + '</b><span>menus read</span></div>' +
      '<div class="stat"><b>' + s.dishes + '</b><span>dishes</span></div>' +
      '<div class="stat"><b>' + s.ingredients + '</b><span>ingredients</span></div>' +
      (s.avgError != null ? '<div class="stat"><b>&plusmn;' + (s.avgError * 100).toFixed(0) + '%</b><span>avg. difference from history</span></div>' : '') +
      '</div>' +
      '<p class="muted small">' + esc(prettyDate(s.firstDate)) + ' to ' + esc(prettyDate(s.lastDate)) + '. ' + (weak ? plural(weak, 'dish', 'dishes') + ' made only once (rough estimates).' : '') + '</p>' +
      warnList(warnings) +
      '<details class="help"><summary>Dishes found</summary><p class="small">' + dishes.map((d) => esc(d.name) + ' <span class="muted">(' + d.count + ')</span>').join(', ') + '</p></details>' +
      '<div class="actions" style="margin-top:12px">' +
      '<button type="button" class="btn" data-act="use-import">Use on this device</button>' +
      '<button type="button" class="btn primary" data-act="save-import" ' + (S.canWrite() ? '' : 'disabled title="Connect GitHub first"') + '>Use &amp; save to GitHub</button></div>';
  }

  function canonicalCsv(menus) {
    const rows = [['Date', 'Meal', 'Thaals', 'Menu', 'Ingredient', 'Qty', 'Unit']];
    menus.forEach((m) => m.ingredients.forEach((i, idx) => {
      rows.push(idx === 0 ? [m.date, m.meal, m.thaals, E.splitDishes(m.dishes).join(' + '), i.name, r6(i.qty), i.unit] : ['', '', '', '', i.name, r6(i.qty), i.unit]);
    }));
    return rows.map((r) => r.map((c) => { const s = String(c); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\n') + '\n';
  }

  function useImported(save) {
    const m = state.importModel;
    if (!m) return;
    S.useModelLocally(m);
    state.model = m;
    renderAllViews();
    if (!save) { toast('New formulas are in use on this device'); return; }
    setImportStatus('Saving to GitHub...');
    S.saveModelToRepo(m, canonicalCsv(state.importMenus || [])).then(() => {
      setImportStatus('Saved to GitHub.', 'ok');
      toast('Formulas saved to GitHub');
    }).catch((e) => setImportStatus('Could not save: ' + e.message, 'err'));
  }

  /* ================================================================== */
  /* shared                                                              */
  /* ================================================================== */

  function renderSyncPill(st) {
    st = st || S.status();
    const pill = $('syncPill');
    pill.dataset.state = st.state;
    const label = {
      local: 'On this device',
      synced: 'Saved to GitHub',
      pending: st.pending + ' waiting',
      syncing: 'Saving...',
      error: 'Not synced'
    }[st.state];
    pill.querySelector('.label').textContent = label;
    pill.title = st.state === 'error' ? st.error : st.state === 'local' ? 'GitHub is not connected - tap to set it up' : label;
    if (state.toastOnSync && st.state === 'synced') { state.toastOnSync = false; toast('Saved to GitHub ✓'); }
    if (state.toastOnSync && st.state === 'error') { state.toastOnSync = false; toast('Saved on this device. GitHub: ' + st.error, 5000); }
    if (state.tab === 'settings') renderDeviceInfo();
  }

  function fillIngredientList() {
    const names = {};
    Object.values(state.model.ingredients || {}).forEach((i) => { names[i.name] = 1; });
    Object.values(state.manual || {}).forEach((m) => (m.ingredients || []).forEach((i) => { names[i.name] = 1; }));
    $('ingredientList').innerHTML = Object.keys(names).sort().map((n) => '<option value="' + esc(n) + '">').join('');
  }

  function renderAllViews() {
    $('sampleBanner').hidden = !state.model.sample;
    fillIngredientList();
    update();
    if (state.tab === 'history') renderHistory();
    if (state.tab === 'dishes') renderDishes();
    if (state.tab === 'settings') renderSettings();
  }

  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tabs button').forEach((b) => {
      const on = b.dataset.tab === tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== 'tab-' + tab; s.classList.toggle('active', s.id === 'tab-' + tab); });
    if (tab === 'history') { renderHistory(); refreshHistory(); }
    if (tab === 'dishes') renderDishes();
    if (tab === 'settings') renderSettings();
    if (location.hash !== '#' + tab) history.replaceState(null, '', tab === 'calc' ? location.pathname + location.search : '#' + tab);
  }

  /* ================================================================== */
  /* events                                                              */
  /* ================================================================== */

  function bind() {
    document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    document.addEventListener('click', (e) => {
      const g = e.target.closest('[data-goto]');
      if (g) switchTab(g.dataset.goto);
    });
    $('syncPill').addEventListener('click', () => switchTab('settings'));

    // --- menu form ---
    $('fDate').addEventListener('change', (e) => { state.draft.date = e.target.value; update(); });
    $('fMeal').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      state.draft.meal = b.dataset.v; setSeg('fMeal', b.dataset.v); update();
    });
    $('fThaals').addEventListener('input', (e) => { state.draft.thaalsInput = e.target.value; renderThaalHint(); update(); });
    document.querySelectorAll('.step-btn').forEach((b) => b.addEventListener('click', () => {
      const t = Math.max(0, Math.round(E.parseThaals(state.draft.thaalsInput)) + +b.dataset.step);
      state.draft.thaalsInput = t ? String(t) : '';
      $('fThaals').value = state.draft.thaalsInput;
      renderThaalHint(); update();
    }));
    [['fEvent', 'event'], ['fCook', 'cook'], ['fNotes', 'notes']].forEach(([id, k]) => {
      $(id).addEventListener('input', (e) => { state.draft[k] = e.target.value; saveDraft(); compute(); renderConfirmBar(); });
    });
    $('newMenuBtn').addEventListener('click', startNewMenu);

    // --- dish input ---
    const di = $('fDish');
    di.addEventListener('input', () => { state.suggestIndex = -1; renderSuggest(); });
    di.addEventListener('focus', renderSuggest);
    di.addEventListener('blur', () => setTimeout(hideSuggest, 150));
    di.addEventListener('keydown', (e) => {
      const list = $('dishSuggest');
      const n = state.suggestRows ? state.suggestRows.length : 0;
      if (e.key === 'ArrowDown' && !list.hidden) { e.preventDefault(); state.suggestIndex = (state.suggestIndex + 1) % n; renderSuggest(); }
      else if (e.key === 'ArrowUp' && !list.hidden) { e.preventDefault(); state.suggestIndex = (state.suggestIndex - 1 + n) % n; renderSuggest(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (!list.hidden && state.suggestIndex >= 0) pickSuggestion(state.suggestIndex);
        else addDishes(di.value);
      } else if (e.key === 'Escape') hideSuggest();
      else if (e.key === 'Backspace' && !di.value && state.draft.dishes.length) { state.draft.dishes.pop(); update(); }
    });
    $('dishSuggest').addEventListener('mousedown', (e) => {
      const li = e.target.closest('li'); if (!li) return;
      e.preventDefault();
      pickSuggestion(+li.dataset.i);
    });
    $('addDishBtn').addEventListener('click', () => { addDishes(di.value); di.focus(); });
    $('dishChips').addEventListener('click', (e) => {
      const b = e.target.closest('[data-remove-dish]'); if (!b) return;
      state.draft.dishes.splice(+b.dataset.removeDish, 1);
      update();
    });

    $('viewSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      state.draft.view = b.dataset.v; setSeg('viewSeg', b.dataset.v); saveDraft(); renderResult();
    });

    // --- results ---
    const rb = $('resultBody');
    rb.addEventListener('change', (e) => {
      const d = state.draft;
      if (e.target.id === 'includeBase') { d.includeBase = e.target.checked; update(); return; }
      if (e.target.id === 'useExact') { d.useExact = e.target.checked; d.overrides = {}; d.removed = {}; update(); return; }
      const inp = e.target.closest('[data-qty]');
      if (inp) {
        const line = state.lines.find((l) => l.key === inp.dataset.qty);
        if (!line) return;
        const t = state.calc.thaals;
        if (!inp.value.trim()) { inp.value = qty(line.total, line.unit, true).num; return; }
        const r = parseTotalInput(inp.value, inp.dataset.unit, line);
        if (r.error) { toast(r.error); inp.value = qty(line.total, line.unit, true).num; return; }
        const per = r.value / t;
        if (line.extra) d.extras.find((x) => x.id === line.extraId).perThaal = per;
        else if (Math.abs(per - line.calcPerThaal) < 1e-9) delete d.overrides[line.key];
        else d.overrides[line.key] = per;
        update();
      }
    });
    rb.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches('.qty-input')) e.target.blur();
      if (e.key === 'Enter' && (e.target.id === 'addIngName' || e.target.id === 'addIngQty')) { e.preventDefault(); addIngredientRow(); }
    });
    rb.addEventListener('click', (e) => {
      const d = state.draft;
      const t = e.target.closest('button'); if (!t) return;
      if (t.dataset.removeLine) {
        const key = t.dataset.removeLine;
        if (key.indexOf('extra:') === 0) d.extras = d.extras.filter((x) => 'extra:' + x.id !== key);
        else { d.removed[key] = true; delete d.overrides[key]; }
        update();
      } else if (t.dataset.reset) { delete d.overrides[t.dataset.reset]; update(); }
      else if (t.dataset.unremove) { delete d.removed[t.dataset.unremove]; update(); }
      else if (t.dataset.replaceDish) {
        const i = d.dishes.findIndex((n) => canonicalDishName(n) === t.dataset.replaceDish);
        if (i >= 0) d.dishes[i] = t.dataset.with;
        update();
      } else if (t.dataset.newRecipe != null) openDishEditor(null, t.dataset.newRecipe);
      else if (t.dataset.act === 'add-ing') addIngredientRow();
      else if (t.dataset.act === 'copy' || t.dataset.act === 'share') {
        const text = listText({ meal: d.meal, date: d.date, thaals: E.smartNum(state.calc.thaals), dishes: state.calc.dishes.map((x) => x.name), event: d.event, notes: d.notes, ingredients: state.lines });
        if (t.dataset.act === 'share') navigator.share({ text: text }).catch(() => {});
        else copyText(text);
      } else if (t.dataset.act === 'print') window.print();
    });

    $('confirmBtn').addEventListener('click', onConfirm);

    // --- history ---
    $('historySearch').addEventListener('input', renderHistory);
    $('historyRefresh').addEventListener('click', () => refreshHistory(true));
    $('historyList').addEventListener('click', (e) => {
      const head = e.target.closest('[data-entry]');
      if (head) { state.openEntries[head.dataset.entry] = !state.openEntries[head.dataset.entry]; renderHistory(); return; }
      const more = e.target.closest('[data-act="more-history"]');
      if (more) { state.historyLimit += 40; renderHistory(); return; }
      const b = e.target.closest('[data-hist]'); if (!b) return;
      const entry = findEntry(b.dataset.date, b.dataset.id); if (!entry) return;
      const act = b.dataset.hist;
      if (act === 'edit') loadIntoCalculator(draftFromEntry(entry, b.dataset.date, false), true);
      else if (act === 'reuse') loadIntoCalculator(draftFromEntry(entry, b.dataset.date, true), false);
      else if (act === 'copy') copyText(listText(Object.assign({ date: b.dataset.date }, entry)));
      else if (act === 'delete') {
        modal({
          title: 'Delete this meal?',
          body: '<p><b>' + esc(entry.meal) + '</b> on ' + esc(prettyDate(b.dataset.date, true)) + ': ' + esc((entry.dishes || []).join(', ')) + '</p><p class="muted">It will be removed from the repository as well.</p>',
          actions: [{ label: 'Cancel' }, {
            label: 'Delete', cls: 'primary', onClick: () => {
              S.deleteEntry(b.dataset.date, entry.id);
              if (state.draft.id === entry.id) { state.draft.savedSig = null; state.draft.originalDate = null; saveDraft(); renderConfirmBar(); }
              toast('Deleted');
            }
          }]
        });
      }
    });

    // --- dishes ---
    $('dishSearch').addEventListener('input', renderDishes);
    $('newDishBtn').addEventListener('click', () => openDishEditor(null, $('dishSearch').value));
    $('dishList').addEventListener('click', (e) => {
      const head = e.target.closest('[data-dish]');
      if (head) { state.openDishes[head.dataset.dish] = !state.openDishes[head.dataset.dish]; renderDishes(); return; }
      const nr = e.target.closest('[data-new-recipe]');
      if (nr) { openDishEditor(null, nr.dataset.newRecipe); return; }
      const b = e.target.closest('[data-dish-act]'); if (!b) return;
      const key = b.dataset.key;
      const info = E.listDishes(state.model, state.manual).find((x) => x.key === key);
      if (b.dataset.dishAct === 'add' && info) { addDishes(info.name); switchTab('calc'); toast(info.name + ' added to the menu'); }
      else if (b.dataset.dishAct === 'edit') openDishEditor(key);
      else if (b.dataset.dishAct === 'unmanual') {
        const learned = state.model.dishes[key];
        modal({
          title: learned ? 'Go back to the learned recipe?' : 'Delete this dish?',
          body: learned ? '<p>Your own recipe for <b>' + esc(info.name) + '</b> will be removed and the quantities learned from history will be used again.</p>' : '<p><b>' + esc(info.name) + '</b> and its recipe will be removed.</p>',
          actions: [{ label: 'Cancel' }, {
            label: learned ? 'Use learned recipe' : 'Delete', cls: 'primary', onClick: () => {
              S.saveManual(key, { name: info.name, ingredients: [], deleted: true });
              state.manual = S.getManual();
              refreshAfterRecipeChange();
            }
          }]
        });
      }
    });

    // --- settings ---
    $('ghSave').addEventListener('click', () => {
      S.saveConfig({ owner: $('ghOwner').value, repo: $('ghRepo').value, branch: $('ghBranch').value || 'main', token: $('ghToken').value });
      const st = $('ghStatus');
      st.className = 'status-text'; st.textContent = 'Testing...';
      S.testConnection().then((msg) => {
        st.className = 'status-text ok'; st.textContent = msg;
        S.sync();
        refreshHistory();
        S.loadModel().then((m) => { if (m && m.trainedAt && m.trainedAt !== state.model.trainedAt) { state.model = m; renderAllViews(); } });
        S.loadManual().then((man) => { state.manual = man; renderAllViews(); });
      }).catch((err) => { st.className = 'status-text err'; st.textContent = err.message; });
    });
    $('importRead').addEventListener('click', readImport);
    $('importFile').addEventListener('change', () => {
      const f = $('importFile').files[0];
      if (f) { $('importPaste').value = ''; setImportStatus(f.name + ' selected.'); readImport(); }
    });
    $('importMapping').addEventListener('change', (e) => {
      const imp = state.importData; if (!imp) return;
      if (e.target.id === 'impSheet') { imp.sheet = e.target.value === 'all' ? 'all' : +e.target.value; renderMapping(); return; }
      const sh = imp.sheets[imp.sheet === 'all' ? 0 : imp.sheet];
      if (e.target.id === 'impHeader') {
        sh.headerAt = Math.max(0, Math.min(sh.rows.length - 1, (+e.target.value || 1) - 1));
        sh.mapping = E.autoMapColumns(sh.rows[sh.headerAt].map(String));
        renderMapping(); return;
      }
      if (e.target.dataset.map) sh.mapping[e.target.dataset.map] = e.target.value === '' ? null : +e.target.value;
    });
    document.getElementById('tab-settings').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      if (b.dataset.act === 'analyse') analyseImport();
      else if (b.dataset.act === 'use-import') useImported(false);
      else if (b.dataset.act === 'save-import') useImported(true);
      else if (b.dataset.act === 'drop-local-model') {
        S.clearLocalModel();
        state.model = window.MAWAID_MODEL || E.emptyModel();
        S.loadModel().then((m) => { if (m) state.model = m; renderAllViews(); });
        renderAllViews();
      }
    });
    $('syncNow').addEventListener('click', () => {
      if (!S.canWrite()) { toast('Connect GitHub first (above)'); return; }
      S.sync().then((ok) => toast(ok ? 'Everything is saved to GitHub' : 'Could not sync: ' + S.status().error));
    });
    $('backupBtn').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(S.exportBackup(), null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'mawaid-backup-' + todayISO() + '.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    $('clearDevice').addEventListener('click', () => {
      const n = S.getPending().length;
      modal({
        title: 'Clear this device?',
        body: '<p>Saved menus, the current draft and imported formulas will be removed from this browser. GitHub settings are kept.</p>' +
          (n ? '<div class="note warn">' + plural(n, 'change has', 'changes have') + ' not reached GitHub yet and will be lost.</div>' : ''),
        actions: [{ label: 'Cancel' }, {
          label: 'Clear', cls: 'primary', onClick: () => {
            S.clearDevice(true);
            state.draft = newDraft();
            state.manual = {};
            state.model = window.MAWAID_MODEL || E.emptyModel();
            renderForm();
            renderAllViews();
            toast('This device was cleared');
          }
        }]
      });
    });

    S.on('status', renderSyncPill);
    S.on('days', () => { if (state.tab === 'history') renderHistory(); });
    window.addEventListener('hashchange', () => {
      const t = location.hash.slice(1);
      if (['calc', 'history', 'dishes', 'settings'].indexOf(t) >= 0 && t !== state.tab) switchTab(t);
    });
  }

  function addIngredientRow() {
    const name = ($('addIngName').value || '').trim();
    const q = E.parseQuantity($('addIngQty').value, $('addIngUnit').value);
    const t = state.calc.thaals;
    if (!name) { toast('Type the ingredient name'); $('addIngName').focus(); return; }
    if (!q || !(q.value > 0)) { toast('Type the total quantity'); $('addIngQty').focus(); return; }
    if (!t) { toast('Enter the number of thaals first'); return; }
    state.draft.extras.push({ id: uid(), name: E.titleCase(name), unit: q.unit, perThaal: q.value / t });
    update();
    $('addIngName').focus();
  }

  function addIngNameUnitHint() {
    // when an existing ingredient is picked, choose its usual unit
    document.addEventListener('change', (e) => {
      if (e.target.id !== 'addIngName' && !e.target.classList.contains('er-name')) return;
      const n = E.normKey(e.target.value);
      const meta = Object.values(state.model.ingredients || {}).find((i) => E.normKey(i.name) === n);
      if (!meta) return;
      const sel = e.target.id === 'addIngName' ? $('addIngUnit') : e.target.closest('.edit-row').querySelector('.er-unit');
      const u = meta.unit;
      if (sel && E.UNIT_CHOICES.indexOf(u) >= 0) sel.value = e.target.id === 'addIngName' ? u : (u === 'kg' ? 'g' : u === 'L' ? 'ml' : u);
    });
  }

  /* ================================================================== */
  /* start                                                               */
  /* ================================================================== */

  function init() {
    bind();
    addIngNameUnitHint();
    renderForm();
    renderAllViews();
    renderSyncPill();
    const t = location.hash.slice(1);
    if (['history', 'dishes', 'settings'].indexOf(t) >= 0) switchTab(t);

    // Newer formulas / recipes from the website or GitHub
    S.loadModel().then((m) => {
      if (m && m.trainedAt && m.trainedAt !== state.model.trainedAt) { state.model = m; renderAllViews(); }
    });
    S.loadManual().then((man) => { state.manual = man; renderAllViews(); });
    refreshHistory();
    S.sync();
  }

  init();
})();
