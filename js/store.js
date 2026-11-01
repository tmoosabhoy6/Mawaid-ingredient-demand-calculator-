/*
 * Mawaid Store - the GitHub repository is the database.
 *
 *   data/YYYY-MM-DD.json        one file per day (all confirmed meals that day)
 *   model/model.json            learned per-thaal formulas
 *   model/manual-recipes.json   recipes typed in by hand (override learned ones)
 *
 * Everything is written to this device first, then pushed to GitHub. If the
 * push fails (offline, no token yet) it is queued and retried every 30 seconds.
 */
(function () {
  'use strict';

  var K = {
    gh: 'mawaid.github',
    days: 'mawaid.days',
    pending: 'mawaid.pending',
    shas: 'mawaid.shas',
    manual: 'mawaid.manual',
    manualDirty: 'mawaid.manualDirty',
    model: 'mawaid.model',
    lastSync: 'mawaid.lastSync'
  };

  var LS = {
    get: function (k, d) {
      try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set: function (k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { console.warn('localStorage write failed', k, e); return false; }
    },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };

  /* ---------------- events ---------------- */
  var listeners = {};
  function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
  function emit(evt, data) { (listeners[evt] || []).forEach(function (fn) { try { fn(data); } catch (e) { console.error(e); } }); }

  /* ---------------- settings ---------------- */
  function detectPagesRepo() {
    // https://<owner>.github.io/<repo>/  ->  owner / repo
    var m = location.hostname.match(/^([^.]+)\.github\.io$/i);
    if (!m) return {};
    var repo = location.pathname.split('/').filter(Boolean)[0];
    return repo ? { owner: m[1], repo: repo } : {};
  }
  function config() {
    return Object.assign({ branch: 'main' }, window.MAWAID_CONFIG || {}, detectPagesRepo(), LS.get(K.gh, {}));
  }
  function saveConfig(c) {
    LS.set(K.gh, { owner: (c.owner || '').trim(), repo: (c.repo || '').trim(), branch: (c.branch || 'main').trim(), token: (c.token || '').trim() });
    emit('status', status());
  }
  function canWrite() { var c = config(); return !!(c.owner && c.repo && c.token); }
  function canRead() { var c = config(); return !!(c.owner && c.repo); }

  /* ---------------- base64 (UTF-8 safe) ---------------- */
  function b64encode(text) {
    var bytes = new TextEncoder().encode(text);
    var bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64decode(b64) {
    var bin = atob(String(b64).replace(/\s/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  /* ---------------- GitHub API ---------------- */
  function encPath(p) { return p.split('/').map(encodeURIComponent).join('/'); }

  function friendlyError(status, msg) {
    if (status === 0) return 'No internet connection (or GitHub unreachable).';
    if (status === 401) return 'The GitHub token is wrong or has expired.';
    if (status === 403 && /rate limit/i.test(msg)) return 'GitHub rate limit reached - add a token in Settings or wait an hour.';
    if (status === 403) return 'The token does not have permission. It needs "Contents: Read and write" on this repository.';
    if (status === 404) return 'Repository, branch or file not found (or the token cannot see this repository).';
    if (status === 409 || status === 422) return 'GitHub rejected the change (' + msg + ').';
    return 'GitHub error ' + status + (msg ? ': ' + msg : '');
  }

  function apiCall(path, opts) {
    opts = opts || {};
    var c = config();
    var headers = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (c.token) headers.Authorization = 'Bearer ' + c.token;
    if (opts.body) headers['Content-Type'] = 'application/json';
    var url = 'https://api.github.com/repos/' + encodeURIComponent(c.owner) + '/' + encodeURIComponent(c.repo) + path;
    return fetch(url, { method: opts.method || 'GET', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined, cache: 'no-store' })
      .catch(function () { var e = new Error(friendlyError(0)); e.status = 0; throw e; })
      .then(function (res) {
        if (res.ok || (opts.allow404 && res.status === 404)) return res;
        return res.json().catch(function () { return {}; }).then(function (j) {
          var e = new Error(friendlyError(res.status, j.message || ''));
          e.status = res.status; e.raw = j.message || '';
          throw e;
        });
      });
  }

  function getBlob(sha) {
    return apiCall('/git/blobs/' + sha).then(function (r) { return r.json(); }).then(function (j) { return b64decode(j.content); });
  }

  /** -> {text, sha} or null if the file does not exist */
  function getFile(path) {
    var c = config();
    return apiCall('/contents/' + encPath(path) + '?ref=' + encodeURIComponent(c.branch), { allow404: true })
      .then(function (res) {
        if (res.status === 404) return null;
        return res.json().then(function (j) {
          if (j.encoding === 'base64' && j.content) return { text: b64decode(j.content), sha: j.sha };
          return getBlob(j.sha).then(function (text) { return { text: text, sha: j.sha }; }); // > 1 MB
        });
      });
  }

  function putFile(path, text, message, sha) {
    var c = config();
    var body = { message: message, content: b64encode(text), branch: c.branch };
    if (sha) body.sha = sha;
    return apiCall('/contents/' + encPath(path), { method: 'PUT', body: body })
      .then(function (r) { return r.json(); })
      .then(function (j) { return j.content && j.content.sha; });
  }

  function deleteFile(path, sha, message) {
    var c = config();
    return apiCall('/contents/' + encPath(path), { method: 'DELETE', body: { message: message, sha: sha, branch: c.branch } });
  }

  function listDir(path) {
    var c = config();
    return apiCall('/contents/' + encPath(path) + '?ref=' + encodeURIComponent(c.branch), { allow404: true })
      .then(function (res) { return res.status === 404 ? [] : res.json(); })
      .then(function (j) { return Array.isArray(j) ? j : []; });
  }

  /** Check the connection; resolves with a description, rejects with a friendly error */
  function testConnection() {
    var c = config();
    if (!c.owner || !c.repo) return Promise.reject(new Error('Enter the repository owner and name.'));
    return apiCall('').then(function (r) { return r.json(); }).then(function (repo) {
      return apiCall('/branches/' + encodeURIComponent(c.branch), { allow404: true }).then(function (br) {
        if (br.status === 404) throw new Error('Branch "' + c.branch + '" does not exist in ' + repo.full_name + '. The default branch is "' + repo.default_branch + '".');
        var canPush = repo.permissions ? repo.permissions.push : false;
        if (!c.token) return 'Connected to ' + repo.full_name + ' (read only - add a token to save).';
        if (!canPush) throw new Error('Connected, but this token cannot write to ' + repo.full_name + '. Give it "Contents: Read and write".');
        return 'Connected to ' + repo.full_name + ' (' + c.branch + '). Saving is ready.';
      });
    });
  }

  /* ---------------- days: local mirror + queue ---------------- */
  var MEAL_ORDER = { Breakfast: 0, Lunch: 1, Dinner: 2 };
  function sortEntries(entries) {
    entries.sort(function (a, b) {
      var ma = MEAL_ORDER[a.meal] != null ? MEAL_ORDER[a.meal] : 3, mb = MEAL_ORDER[b.meal] != null ? MEAL_ORDER[b.meal] : 3;
      return ma - mb || String(a.confirmedAt).localeCompare(String(b.confirmedAt));
    });
    return entries;
  }

  function applyOp(day, op) {
    day.entries = (day.entries || []).filter(function (e) { return e.id !== (op.entry ? op.entry.id : op.id); });
    if (op.op === 'save') day.entries.push(op.entry);
    sortEntries(day.entries);
    return day;
  }

  function getDays() { return LS.get(K.days, {}); }
  function getPending() { return LS.get(K.pending, []); }
  function pendingIds() {
    var ids = {};
    getPending().forEach(function (op) { ids[op.entry ? op.entry.id : op.id] = op.op; });
    return ids;
  }

  function queue(op) {
    var days = getDays();
    var day = days[op.date] || { date: op.date, entries: [] };
    days[op.date] = applyOp(day, op);
    if (!days[op.date].entries.length) delete days[op.date];
    LS.set(K.days, days);
    var pending = getPending();
    pending.push(op);
    LS.set(K.pending, pending);
    emit('days', days);
    emit('status', status());
    sync();
  }

  function opId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function saveEntry(date, entry) { queue({ opId: opId(), op: 'save', date: date, entry: entry, at: new Date().toISOString() }); }
  function deleteEntry(date, id) { queue({ opId: opId(), op: 'delete', date: date, id: id, at: new Date().toISOString() }); }

  function describe(op) {
    if (op.op === 'delete') return 'Remove entry';
    var e = op.entry;
    return e.meal + ' - ' + e.thaals + ' thaals (' + (e.dishes || []).join(', ') + ')';
  }

  function pushDay(date, ops, attempt) {
    attempt = attempt || 0;
    var path = 'data/' + date + '.json';
    return getFile(path).then(function (remote) {
      var day = remote ? JSON.parse(remote.text) : { date: date, entries: [] };
      ops.forEach(function (op) { applyOp(day, op); });
      day.date = date;
      day.updatedAt = new Date().toISOString();
      var msg = 'Mawaid ' + date + ': ' + ops.map(describe).join('; ');
      if (msg.length > 200) msg = msg.slice(0, 197) + '...';
      var shas = LS.get(K.shas, {});
      if (!day.entries.length) {
        if (!remote) return day;
        return deleteFile(path, remote.sha, msg).then(function () { delete shas[path]; LS.set(K.shas, shas); return day; });
      }
      return putFile(path, JSON.stringify(day, null, 2) + '\n', msg, remote && remote.sha).then(function (sha) {
        shas[path] = sha; LS.set(K.shas, shas);
        return day;
      });
    }).catch(function (e) {
      if ((e.status === 409 || e.status === 422) && attempt < 3) return pushDay(date, ops, attempt + 1); // someone else saved - retry
      throw e;
    });
  }

  var syncing = null;
  var lastError = '';

  function sync() {
    if (syncing) return syncing;
    if (!canWrite()) { emit('status', status()); return Promise.resolve(false); }
    var pending = getPending();
    var manualDirty = LS.get(K.manualDirty, false);
    if (!pending.length && !manualDirty) { emit('status', status()); return Promise.resolve(true); }
    emit('status', Object.assign(status(), { state: 'syncing' }));

    var byDate = {}, dates = [];
    pending.forEach(function (op) { if (!byDate[op.date]) { byDate[op.date] = []; dates.push(op.date); } byDate[op.date].push(op); });

    var chain = Promise.resolve();
    dates.forEach(function (date) {
      chain = chain.then(function () {
        return pushDay(date, byDate[date]).then(function (day) {
          // remove the ops we pushed (new ones may have been queued meanwhile)
          var pushedIds = byDate[date].map(function (p) { return p.opId; });
          var rest = getPending().filter(function (op) { return pushedIds.indexOf(op.opId) < 0; });
          LS.set(K.pending, rest);
          var days = getDays();
          // re-apply anything still pending for this date
          rest.filter(function (op) { return op.date === date; }).forEach(function (op) { applyOp(day, op); });
          if (day.entries.length) days[date] = day; else delete days[date];
          LS.set(K.days, days);
        });
      });
    });
    if (manualDirty) chain = chain.then(pushManual);

    syncing = chain.then(function () {
      lastError = '';
      LS.set(K.lastSync, new Date().toISOString());
      return true;
    }).catch(function (e) {
      lastError = e.message;
      console.warn('Sync failed:', e);
      return false;
    }).then(function (ok) {
      syncing = null;
      emit('days', getDays());
      emit('status', status());
      return ok;
    });
    return syncing;
  }

  function status() {
    var n = getPending().length + (LS.get(K.manualDirty, false) ? 1 : 0);
    var state;
    if (!canWrite()) state = 'local';
    else if (lastError) state = 'error';
    else if (n) state = 'pending';
    else state = 'synced';
    return { state: state, pending: n, error: lastError, lastSync: LS.get(K.lastSync, ''), canWrite: canWrite(), canRead: canRead() };
  }

  /** Pull all day files from GitHub into the local mirror (only changed files are downloaded). */
  function refreshHistory() {
    if (!canRead()) return Promise.resolve({ remote: false });
    return listDir('data').then(function (files) {
      var dayFiles = files.filter(function (f) { return f.type === 'file' && /^\d{4}-\d{2}-\d{2}\.json$/.test(f.name); });
      var shas = LS.get(K.shas, {});
      var days = getDays();
      var todo = dayFiles.filter(function (f) { return shas[f.path] !== f.sha || !days[f.name.slice(0, 10)]; });
      var fetched = {};
      var i = 0;
      function worker() {
        if (i >= todo.length) return Promise.resolve();
        var f = todo[i++];
        return getBlob(f.sha).then(function (text) {
          try { fetched[f.name.slice(0, 10)] = { day: JSON.parse(text), path: f.path, sha: f.sha }; }
          catch (e) { console.warn('Bad JSON in', f.path); }
        }).then(worker);
      }
      var workers = [];
      for (var w = 0; w < 5; w++) workers.push(worker());
      return Promise.all(workers).then(function () {
        days = getDays();
        shas = LS.get(K.shas, {});
        var remoteDates = {};
        dayFiles.forEach(function (f) { remoteDates[f.name.slice(0, 10)] = true; });
        var pending = getPending();
        var pendingDates = {};
        pending.forEach(function (op) { pendingDates[op.date] = true; });
        // files deleted on GitHub
        Object.keys(days).forEach(function (d) {
          if (!remoteDates[d] && !pendingDates[d]) { delete days[d]; delete shas['data/' + d + '.json']; }
        });
        Object.keys(fetched).forEach(function (d) {
          var day = fetched[d].day;
          pending.filter(function (op) { return op.date === d; }).forEach(function (op) { applyOp(day, op); });
          days[d] = day;
          shas[fetched[d].path] = fetched[d].sha;
        });
        LS.set(K.days, days);
        LS.set(K.shas, shas);
        emit('days', days);
        return { remote: true, files: dayFiles.length, downloaded: todo.length };
      });
    });
  }

  /* ---------------- model ---------------- */
  function newer(a, b) { return (a && a.trainedAt || '') > (b && b.trainedAt || '') ? a : b; }

  function fetchRelativeJson(path) {
    if (!/^https?:/.test(location.protocol)) return Promise.resolve(null);
    return fetch(path, { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  function fetchRepoJson(path) {
    if (!canRead()) return Promise.resolve(null);
    return getFile(path).then(function (f) { return f ? JSON.parse(f.text) : null; }).catch(function () { return null; });
  }

  /** Best model available right now (bundled file or one imported on this device) */
  function localModel() {
    return newer(LS.get(K.model, null), window.MAWAID_MODEL || null) || null;
  }
  /** Also check the website copy and the GitHub copy; resolves with the newest */
  function loadModel() {
    return Promise.all([fetchRelativeJson('model/model.json'), fetchRepoJson('model/model.json')]).then(function (r) {
      var best = newer(newer(r[1], r[0]), localModel());
      return best;
    });
  }
  function useModelLocally(model) { LS.set(K.model, model); }
  function clearLocalModel() { LS.del(K.model); }

  function saveModelToRepo(model, rawCsv) {
    var json = JSON.stringify(model);
    var when = new Date().toISOString().slice(0, 10);
    var msg = 'Update ingredient formulas (' + model.stats.menus + ' menus, ' + model.stats.dishes + ' dishes)';
    function put(path, text, m) {
      return getFile(path).then(function (f) { return putFile(path, text, m, f && f.sha); });
    }
    return put('model/model.json', json + '\n', msg)
      .then(function () { return put('model/model.js', '/* Generated by the app - do not edit */\nwindow.MAWAID_MODEL = ' + json + ';\n', msg); })
      .then(function () { if (rawCsv) return put('history/imported-' + when + '.csv', rawCsv, 'Add imported history sheet ' + when); });
  }

  /* ---------------- manual recipes ---------------- */
  function mergeManual(a, b) {
    var out = Object.assign({}, a || {});
    Object.keys(b || {}).forEach(function (k) {
      if (!out[k] || String(b[k].updatedAt || '') > String(out[k].updatedAt || '')) out[k] = b[k];
    });
    return out;
  }
  function getManual() { return LS.get(K.manual, {}); }
  function loadManual() {
    return Promise.all([fetchRelativeJson('model/manual-recipes.json'), fetchRepoJson('model/manual-recipes.json')]).then(function (r) {
      var merged = mergeManual(mergeManual(r[0], r[1]), getManual());
      LS.set(K.manual, merged);
      return merged;
    });
  }
  function saveManual(key, recipe) {
    var all = getManual();
    all[key] = Object.assign({}, recipe, { updatedAt: new Date().toISOString() });
    LS.set(K.manual, all);
    LS.set(K.manualDirty, true);
    emit('status', status());
    sync();
    return all;
  }
  function pushManual(attempt) {
    attempt = attempt || 0;
    var path = 'model/manual-recipes.json';
    return getFile(path).then(function (f) {
      var merged = mergeManual(f ? JSON.parse(f.text) : {}, getManual());
      return putFile(path, JSON.stringify(merged, null, 2) + '\n', 'Update hand-entered recipes', f && f.sha).then(function () {
        LS.set(K.manual, merged);
        LS.set(K.manualDirty, false);
      });
    }).catch(function (e) {
      if ((e.status === 409 || e.status === 422) && attempt < 3) return pushManual(attempt + 1);
      throw e;
    });
  }

  /* ---------------- device ---------------- */
  function exportBackup() {
    return { exportedAt: new Date().toISOString(), days: getDays(), pending: getPending(), manual: getManual() };
  }
  function clearDevice(keepSettings) {
    Object.keys(K).forEach(function (k) { if (!(keepSettings && k === 'gh')) LS.del(K[k]); });
    LS.del('mawaid.draft');
    emit('days', {});
    emit('status', status());
  }

  // background sync every N seconds, and whenever we come back online
  var every = ((window.MAWAID_CONFIG || {}).syncEverySeconds || 30) * 1000;
  setInterval(function () { if (getPending().length || LS.get(K.manualDirty, false)) sync(); }, every);
  window.addEventListener('online', function () { sync(); });

  window.MawaidStore = {
    LS: LS,
    on: on,
    config: config,
    saveConfig: saveConfig,
    canWrite: canWrite,
    canRead: canRead,
    testConnection: testConnection,
    getDays: getDays,
    getPending: getPending,
    pendingIds: pendingIds,
    saveEntry: saveEntry,
    deleteEntry: deleteEntry,
    sync: sync,
    status: status,
    refreshHistory: refreshHistory,
    localModel: localModel,
    loadModel: loadModel,
    useModelLocally: useModelLocally,
    clearLocalModel: clearLocalModel,
    saveModelToRepo: saveModelToRepo,
    getManual: getManual,
    loadManual: loadManual,
    saveManual: saveManual,
    exportBackup: exportBackup,
    clearDevice: clearDevice
  };
})();
