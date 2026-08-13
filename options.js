/* Questions manager. */

/* Fire-and-forget messaging. With no listener (panel closed, worker asleep)
   Chrome rejects the promise — that is expected, not a failure, so swallow it.
   A plain try/catch cannot: the rejection is asynchronous. */
function tell(msg, cb) {
  try {
    const p = cb ? chrome.runtime.sendMessage(msg, cb) : chrome.runtime.sendMessage(msg);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) {}
}


let rules = [];
const listEl = document.getElementById('list');
const savedEl = document.getElementById('saved');
const prefillHost = new URLSearchParams(location.search).get('host') || '';

function flash(msg) {
  savedEl.textContent = msg;
  setTimeout(() => { savedEl.textContent = ''; }, 1800);
}

async function save() {
  await QA.setRules(rules);
  flash('Saved.');
}

function lines(v) {
  return v.split('\n').map((s) => s.trim()).filter(Boolean);
}
function commas(v) {
  return v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}

function card(rule, idx) {
  const c = document.createElement('div');
  c.className = 'card' + (rule.enabled ? '' : ' off');

  const head = document.createElement('div');
  head.className = 'head';
  const on = document.createElement('input');
  on.type = 'checkbox';
  on.checked = !!rule.enabled;
  on.title = 'Enabled';
  on.addEventListener('change', () => { rule.enabled = on.checked; save(); c.className = 'card' + (rule.enabled ? '' : ' off'); });
  const name = document.createElement('input');
  name.type = 'text';
  name.value = rule.name || '';
  name.placeholder = 'e.g. Any new documents for Acme?';
  name.addEventListener('change', () => { rule.name = name.value; save(); });
  head.appendChild(on);
  head.appendChild(name);
  c.appendChild(head);

  const row = document.createElement('div');
  row.className = 'row';

  function field(labelText, value, hint, placeholder, onChange) {
    const wrap = document.createElement('div');
    const l = document.createElement('label');
    l.textContent = labelText;
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.placeholder = placeholder || '';
    ta.addEventListener('change', () => { onChange(ta.value); save(); });
    const h = document.createElement('div');
    h.className = 'hint';
    h.textContent = hint;
    wrap.appendChild(l);
    wrap.appendChild(ta);
    wrap.appendChild(h);
    return wrap;
  }

  row.appendChild(field(
    'Run on these sites', (rule.sites || []).join('\n'),
    'One pattern per line. * is a wildcard. Examples: calendar.google.com/*  ·  drive.google.com/*  ·  *acmecorp*  ·  * (everywhere)',
    'calendar.google.com/*',
    (v) => { rule.sites = lines(v).length ? lines(v) : ['*']; }
  ));

  row.appendChild(field(
    'My avatar initials', (rule.initials || []).join(', '),
    'For board apps like Trello/Jira where the assignee is only an avatar circle. Matched exactly against a card\'s avatar labels — never against body text. Use “Who\'s on this page?” in the popup to find yours.',
    'R',
    (v) => { rule.initials = commas(v); }
  ));

  row.appendChild(field(
    'People / names to watch', (rule.names || []).join(', '),
    'Your own name and handles for "assigned to me" questions, or a client\'s name. Matched names are listed as “Who:” chips in the results.',
    'Rafay, @rafay, taxplan@dilucci.com',
    (v) => { rule.names = commas(v); }
  ));

  row.appendChild(field(
    'Keywords / phrases', (rule.keywords || []).join(', '),
    'Comma or newline separated, case-insensitive. Matched against the text of each block and its link URL.',
    'acme, acme corp, 1099',
    (v) => { rule.keywords = commas(v); }
  ));

  row.appendChild(field(
    'Regex patterns (optional)', (rule.regexes || []).join('\n'),
    'One per line, JS syntax without slashes. Example: INV-\\d{4,}',
    'INV-\\d{4,}',
    (v) => { rule.regexes = lines(v); }
  ));

  c.appendChild(row);

  const bl = document.createElement('label');
  bl.textContent = 'Built-in patterns';
  c.appendChild(bl);
  const checks = document.createElement('div');
  checks.className = 'checks';
  Object.keys(QA.BUILTINS).forEach((key) => {
    const lab = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = (rule.builtins || []).indexOf(key) !== -1;
    cb.addEventListener('change', () => {
      const set = new Set(rule.builtins || []);
      cb.checked ? set.add(key) : set.delete(key);
      rule.builtins = Array.from(set);
      save();
    });
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(QA.BUILTINS[key].label));
    checks.appendChild(lab);
  });
  c.appendChild(checks);

  const acts = document.createElement('div');
  acts.className = 'actions';
  const all = document.createElement('label');
  all.className = 'toggle';
  const allCb = document.createElement('input');
  allCb.type = 'checkbox';
  allCb.checked = !!rule.matchAll;
  allCb.addEventListener('change', () => { rule.matchAll = allCb.checked; save(); });
  all.appendChild(allCb);
  all.appendChild(document.createTextNode('Require every criterion to match (AND instead of OR)'));
  acts.appendChild(all);

  const sp = document.createElement('span');
  sp.className = 'spacer';
  acts.appendChild(sp);

  const dup = document.createElement('button');
  dup.textContent = 'Duplicate';
  dup.addEventListener('click', () => {
    const copy = JSON.parse(JSON.stringify(rule));
    copy.id = QA.newId();
    copy.name = rule.name + ' (copy)';
    rules.splice(idx + 1, 0, copy);
    save().then(draw);
  });
  acts.appendChild(dup);

  const del = document.createElement('button');
  del.textContent = 'Delete';
  del.className = 'danger';
  del.addEventListener('click', () => {
    rules.splice(idx, 1);
    save().then(draw);
  });
  acts.appendChild(del);

  c.appendChild(acts);
  return c;
}

function draw() {
  listEl.innerHTML = '';
  if (!rules.length) {
    const p = document.createElement('p');
    p.className = 'lede';
    p.textContent = 'No questions yet. Click “New question”.';
    listEl.appendChild(p);
    return;
  }
  rules.forEach((r, i) => listEl.appendChild(card(r, i)));
}

document.getElementById('add').addEventListener('click', async () => {
  rules.unshift({
    id: QA.newId(),
    name: 'New question',
    enabled: true,
    sites: [prefillHost ? prefillHost + '/*' : '*'],
    initials: [],
    names: [],
    keywords: [],
    regexes: [],
    builtins: [],
    matchAll: false
  });
  await save();
  draw();
  const first = listEl.querySelector('input[type=text]');
  if (first) { first.focus(); first.select(); }
});

document.getElementById('reset').addEventListener('click', async () => {
  rules = JSON.parse(JSON.stringify(QA.DEFAULT_RULES));
  await save();
  draw();
});

const autoCb = document.getElementById('autoCheck');
chrome.storage.sync.get({ autoCheck: true }).then((g) => { autoCb.checked = g.autoCheck !== false; });
autoCb.addEventListener('change', () => {
  chrome.storage.sync.set({ autoCheck: autoCb.checked });
  flash('Saved.');
});

/* ---------- Ask Claude settings ---------- */

const keyEl = document.getElementById('aikey');
const modelEl = document.getElementById('aimodel');
const enEl = document.getElementById('aienabled');
const stateEl = document.getElementById('keystate');

QA.AI_MODELS.forEach((m) => {
  const o = document.createElement('option');
  o.value = m.id;
  o.textContent = m.label;
  modelEl.appendChild(o);
});

function keyLabel(k) {
  if (!k) return 'No key saved yet — the Ask box will tell you to come here.';
  return 'Key saved (…' + k.slice(-4) + ').';
}

QA.getAI().then((cfg) => {
  keyEl.value = cfg.apiKey || '';
  modelEl.value = cfg.model || 'claude-sonnet-5';
  enEl.checked = cfg.enabled !== false;
  stateEl.textContent = ' ' + keyLabel(cfg.apiKey);
});

keyEl.addEventListener('change', async () => {
  const v = keyEl.value.trim();
  await QA.setAI({ apiKey: v });
  stateEl.textContent = ' ' + keyLabel(v);
  flash('Saved.');
});
modelEl.addEventListener('change', async () => { await QA.setAI({ model: modelEl.value }); flash('Saved.'); });
enEl.addEventListener('change', async () => { await QA.setAI({ enabled: enEl.checked }); flash('Saved.'); });
document.getElementById('aiclear').addEventListener('click', async () => {
  keyEl.value = '';
  await QA.setAI({ apiKey: '' });
  stateEl.textContent = ' ' + keyLabel('');
  flash('Key removed.');
});

if (location.hash === '#ai') document.getElementById('ai').scrollIntoView({ behavior: 'smooth' });

QA.getRules().then((r) => { rules = r; draw(); });

/* ---------- desktop notifications ---------- */

const nOn = document.getElementById('notifyOn');
const nState = document.getElementById('notifyState');

chrome.storage.sync.get({ notify: null }).then((g) => {
  const cfg = Object.assign({ on: true }, g.notify || {});
  nOn.checked = cfg.on !== false;
});

nOn.addEventListener('change', async () => {
  const g = await chrome.storage.sync.get({ notify: null });
  await chrome.storage.sync.set({ notify: Object.assign({}, g.notify || {}, { on: nOn.checked }) });
  flash('Saved.');
});

document.getElementById('notifyTest').addEventListener('click', () => {
  tell({ type: 'testNotification' });
  nState.textContent = ' Sent — if nothing appeared, Chrome needs notification permission in your system settings.';
});

document.getElementById('notifyNow').addEventListener('click', () => {
  nState.textContent = ' Checking…';
  tell({ type: 'checkNow' }, (r) => {
    if (!r) { nState.textContent = ' No answer from the extension.'; return; }
    if (r.skipped === 'no trello tab') nState.textContent = ' No Trello tab is open, so there was nothing to read.';
    else if (r.skipped === 'off') nState.textContent = ' Notifications are switched off.';
    else if (r.skipped) nState.textContent = ' Could not check (' + r.skipped + ').';
    else if (r.popped) nState.textContent = ' Found ' + r.popped + ' new — notification sent.';
    else nState.textContent = ' Checked. Nothing new.';
  });
});

/* ---------- sorting mentions into buckets ----------
   Off unless he switches it on. The key lives in chrome.storage.local, which is
   never synced to his Google account, and goes nowhere but Google's API. */

const tOn = document.getElementById('triageOn');
const tKey = document.getElementById('triageKey');
const tModel = document.getElementById('triageModel');
const tState = document.getElementById('triageState');

if (tOn && tKey && tModel) {
  /* The model list is fetched from Google, because a list I wrote by hand went
     stale in months — 2.5 Pro stopped being offered and the feature just said
     "404". The constant below is only used when the fetch cannot happen. */
  const fillModels = (models, chosen) => {
    tModel.innerHTML = '';
    models.forEach((m) => {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.label;
      tModel.appendChild(o);
    });
    const has = models.some((m) => m.id === chosen);
    if (!has && chosen) {
      const o = document.createElement('option');
      o.value = chosen;
      o.textContent = chosen + ' — not offered on this key';
      tModel.appendChild(o);
    }
    tModel.value = chosen && (has || chosen) ? chosen : (models[0] && models[0].id);
    return has;
  };

  let LISTED = false;

  const refreshModels = async (key, chosen, quiet) => {
    if (!key) { fillModels(QA.GEMINI_MODELS, chosen); return; }
    if (!quiet) tState.textContent = ' Checking which models your key can use…';
    const got = await QA.listGeminiModels(key);
    if (!got.ok) {
      fillModels(QA.GEMINI_MODELS, chosen);
      if (!quiet) tState.textContent = ' ' + got.why;
      return;
    }
    LISTED = true;
    const stillThere = fillModels(got.models, chosen);
    if (!stillThere && chosen) {
      /* whatever he had picked is gone — move him to something that works */
      const next = got.models[0].id;
      tModel.value = next;
      await QA.setTriage({ model: next });
      tState.textContent = ' ' + chosen + ' is no longer offered on this key — switched to ' + next + '.';
    } else if (!quiet) {
      tState.textContent = ' ' + got.models.length + ' models available on this key.';
    }
  };

  const paint = (cfg) => {
    const card = document.getElementById('triage');
    if (card) card.classList.toggle('off', !cfg.enabled);
    if (cfg.enabled && !cfg.apiKey) {
      tState.textContent = ' Needs a key before it can sort anything.';
    }
  };

  QA.getTriage().then(async (cfg) => {
    tOn.checked = !!cfg.enabled;
    tKey.value = cfg.apiKey || '';
    fillModels(QA.GEMINI_MODELS, cfg.model);
    paint(cfg);
    if (cfg.apiKey) await refreshModels(cfg.apiKey, cfg.model, true);
  });

  const save = async (patch, note) => {
    const cfg = await QA.setTriage(patch);
    paint(cfg);
    if (note) tState.textContent = ' ' + note;
    flash('Saved.');
    return cfg;
  };

  tOn.addEventListener('change', () => save({ enabled: tOn.checked },
    tOn.checked ? '' : 'Off — your list works exactly as before.'));

  tKey.addEventListener('change', async () => {
    const cfg = await save({ apiKey: tKey.value.trim() });
    await refreshModels(cfg.apiKey, cfg.model);
  });

  tModel.addEventListener('change', () => save({ model: tModel.value }));

  const reload = document.getElementById('triageModels');
  if (reload) {
    reload.addEventListener('click', async () => {
      const cfg = await QA.setTriage({ apiKey: tKey.value.trim() });
      await refreshModels(cfg.apiKey, cfg.model);
    });
  }

  document.getElementById('triageTest').addEventListener('click', async () => {
    const cfg = await QA.setTriage({ apiKey: tKey.value.trim(), model: tModel.value });
    if (!cfg.apiKey) { tState.textContent = ' Paste a key first.'; return; }
    if (!LISTED) await refreshModels(cfg.apiKey, cfg.model, true);
    tState.textContent = ' Testing…';
    /* two comments with obviously different answers, so a pass really is a pass */
    const probe = [
      { hash: 'probe-1', actor: 'Paul', cardName: 'Test',
        text: '@rafay10 can you prepare the Q3 forecast before Thursday?' },
      { hash: 'probe-2', actor: 'Gina', cardName: 'Test',
        text: '@rafay10 FYI the client uploaded their paystubs this morning.' }
    ];
    let got = await QA.triageMentions(probe, Object.assign({}, cfg, { enabled: true, model: tModel.value }));

    /* a retired model is worth recovering from rather than reporting */
    if (!got.ok && /no longer offered/.test(got.why || '')) {
      const list = await QA.listGeminiModels(cfg.apiKey);
      if (list.ok && list.models.length) {
        const next = list.models[0].id;
        fillModels(list.models, next);
        await QA.setTriage({ model: next });
        tState.textContent = ' Retrying with ' + next + '…';
        got = await QA.triageMentions(probe, Object.assign({}, cfg, { enabled: true, model: next }));
      }
    }

    if (!got.ok) { tState.textContent = ' ' + (got.why || 'That did not work.'); return; }
    const a = got.buckets['probe-1'];
    const b = got.buckets['probe-2'];
    const right = a && a.key === 'needs' && b && b.key === 'fyi';
    tState.textContent = ' ' + (right
      ? 'Working on ' + tModel.value + ' — it read the forecast as "Needs me" and the paystub note as "FYI".'
      : 'The key works, but it sorted the test oddly (' +
        ((a && a.label) || '?') + ' / ' + ((b && b.label) || '?') + ').');
  });
}

/* ---------- what counts as dealt with ---------- */

const mRead = document.getElementById('trustRead');
const mState = document.getElementById('memoryState');

if (mRead) {
  QA.getMemory().then((m) => {
    mRead.checked = m.trustTrelloRead !== false;
  });
  mRead.addEventListener('change', async () => {
    await QA.setMemory({ trustTrelloRead: mRead.checked });
    mState.textContent = mRead.checked
      ? ' On — your Done list will survive reinstalling.'
      : ' Off — only this extension remembers, so reinstalling will lose it.';
    flash('Saved.');
  });
}

/* ---------- whose day counts ---------- */

const zSel = document.getElementById('zone');
const zNow = document.getElementById('zoneNow');

if (zSel) {
  const showNow = (tz) => {
    const zone = tz === 'local' ? Intl.DateTimeFormat().resolvedOptions().timeZone : tz;
    let there = '';
    let here = '';
    try {
      there = new Date().toLocaleString('en-US', {
        timeZone: zone, weekday: 'short', hour: 'numeric', minute: '2-digit'
      });
      here = new Date().toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    } catch (e) { /* an unknown zone just shows nothing */ }
    zNow.textContent = there
      ? 'There it is ' + there + '. On this computer it is ' + here + '.'
      : '';
  };

  QA.getMemory().then((m) => {
    zSel.value = m.zone || QA.BIZ_ZONE_DEFAULT;
    showNow(zSel.value);
  });

  zSel.addEventListener('change', async () => {
    await QA.setMemory({ zone: zSel.value });
    QA.setZone(zSel.value === 'local'
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : zSel.value);
    showNow(zSel.value);
    flash('Saved.');
  });
}
