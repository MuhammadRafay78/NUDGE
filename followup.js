/* Weekly follow-up: one comment per client card. Nothing posts on its own. */

const el = (id) => document.getElementById(id);

/* Fire-and-forget messaging. With no listener Chrome rejects the promise —
   expected, not a failure. A plain try/catch cannot catch an async rejection. */
function tell(msg, cb) {
  try {
    const p = cb ? chrome.runtime.sendMessage(msg, cb) : chrome.runtime.sendMessage(msg);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) {}
}

let DRAFT = null;

function fmtWeek(ms) {
  if (!ms) return 'next week';
  const a = new Date(ms);
  const b = new Date(ms + 6 * 864e5);
  const opt = { month: 'short', day: 'numeric' };
  return a.toLocaleDateString(undefined, opt) + ' – ' + b.toLocaleDateString(undefined, opt);
}

async function persist() {
  await chrome.storage.local.set({ followupDraft: DRAFT });
}

function matched() {
  return (DRAFT && DRAFT.entries || []).filter((e) => e.cardId);
}

function undecided() {
  return (DRAFT && DRAFT.entries || []).filter((e) => !e.cardId && (e.candidates || []).length);
}

function toSend() {
  return matched().filter((e) => e.include && !e.sent);
}

function setHeader() {
  const all = (DRAFT && DRAFT.entries || []).length;
  const m = matched().length;
  const code = (DRAFT && DRAFT.requireText) || '';
  el('lede').textContent = DRAFT
    ? 'Week of ' + fmtWeek(DRAFT.weekOf) + ' · ' + all + (code ? ' ' + code : '') +
      ' meeting' + (all === 1 ? '' : 's') + ' · ' + m + ' matched to a card' +
      (undecided().length ? ' · ' + undecided().length + ' needing a choice' : '') +
      (DRAFT.ignored ? ' · ' + DRAFT.ignored + ' other meeting' + (DRAFT.ignored === 1 ? '' : 's') + ' ignored' : '') +
      ' · prepared ' + QA.ago(DRAFT.at) +
      (DRAFT.calendarMs
        ? ' in ' + ((DRAFT.calendarMs + (DRAFT.trelloMs || 0)) / 1000).toFixed(1) + 's' +
          (DRAFT.cacheHits ? ' (' + DRAFT.cacheHits + ' cards remembered)' : '')
        : '')
    : 'No draft yet.';
  const n = toSend().length;
  el('send-all').textContent = n ? 'Send all ' + n : 'Send all';
  el('send-all').disabled = !n;
}

/* one card block */
/* a textarea that fits its text, so nothing is cut off mid-sentence */
function grow(ta) {
  if (!ta) return;
  ta.style.height = 'auto';
  const h = ta.scrollHeight;
  if (h) ta.style.height = (h + 2) + 'px';
}

function adminName() {
  const a = (DRAFT && DRAFT.admin) || '';
  return a ? '@' + String(a).replace(/^@/, '') : 'the admin';
}

/* redo the message and the tick after anything changes what we know */
async function refreshEntry(entry) {
  const found = QA.relevantAsks(entry.missing, null, (entry.history && entry.history.received) || []);
  entry.asks = found.asks;
  entry.hiddenCount = found.hidden;
  entry.text = QA.buildCardMessage(entry, (DRAFT && DRAFT.admin) || '');
  entry.include = QA.shouldSendByDefault(entry);
  await persist();
  render();
}

function cardBlock(entry, idx) {
  const p = document.createElement('div');
  p.className = 'panel' + (entry.sent ? ' done' : (entry.include ? '' : ' off'));

  const head = document.createElement('div');
  head.className = 'chead';

  const tick = document.createElement('input');
  tick.type = 'checkbox';
  tick.checked = !!entry.include;
  tick.disabled = !!entry.sent;
  tick.title = 'Include in “Send all”';
  tick.addEventListener('change', async () => {
    entry.include = tick.checked;
    await persist();
    render();
  });
  head.appendChild(tick);

  const name = document.createElement('div');
  name.className = 'cname';
  name.textContent = entry.cardName || entry.client;
  head.appendChild(name);

  const when = document.createElement('div');
  when.className = 'cwhen';
  when.textContent = QA.whenLabel(entry) || 'next week';
  if (entry.dateMs) when.title = new Date(entry.dateMs).toDateString();
  head.appendChild(when);
  p.appendChild(head);

  const asks = entry.asks || [];
  const miss = document.createElement('div');
  if (asks.length) {
    miss.className = 'cmiss';
    miss.textContent = 'Chasing: ' + asks.map((a) => a.label.replace(/\s*\(.*$/, '')).join(', ');
  } else {
    miss.className = 'cmiss none';
    miss.textContent = 'Nothing to chase from the client' + (entry.total ? ' (' + entry.done + '/' + entry.total + ' checklist items done)' : '');
  }
  p.appendChild(miss);

  /* One history line, not two. "Last asked 12h ago" and "Organizer asked 1×,
     last 24 Jul" were answering different questions in separate rows, which read
     like a contradiction. */
  const histBits = [];
  if (entry.chase && entry.chase.count) {
    histBits.push((entry.chase.chased ? 'Already asked ' : 'Asked ') + adminName() + ' ' + entry.chase.ago +
      (entry.chase.count > 1 ? ' (' + entry.chase.count + '×)' : ''));
  }
  if (entry.history && entry.history.known) {
    const h = entry.history;
    (h.received || []).forEach((id) => {
      histBits.push('✓ ' + QA.docLabels([id])[0] + ' in' +
        (h.byDoc[id].at ? ' ' + QA.shortDate(h.byDoc[id].at) : ''));
    });
    Object.keys(h.byDoc).forEach((id) => {
      const r = h.byDoc[id];
      if (r.state === 'received' || !r.chases) return;
      histBits.push(QA.docLabels([id])[0].replace(/^Year-to-date /, 'YTD ') +
        ' ' + r.chases + '×' + (r.at ? ' to ' + QA.shortDate(r.at) : ''));
    });
  }
  if (histBits.length) {
    const seen = document.createElement('div');
    seen.className = entry.chase && entry.chase.chased ? 'warn' : 'meta';
    seen.style.marginBottom = '8px';
    seen.textContent = (entry.chase && entry.chase.chased ? '⏸ ' : '🗒 ') + histBits.join(' · ') +
      (entry.chase && entry.chase.chased ? ' — unticked so it is not asked twice' : '');
    seen.title = [(entry.chase && entry.chase.lastText) || '']
      .concat(Object.keys((entry.history && entry.history.byDoc) || {})
        .filter((k) => entry.history.byDoc[k].quote)
        .map((k) => k + ': “' + entry.history.byDoc[k].quote + '”'))
      .filter(Boolean).join('\n');
    p.appendChild(seen);
  }

  /* if the comments could not be read, say it out loud */
  if (entry.commentsError) {
    const bad = document.createElement('div');
    bad.className = 'warn';
    bad.style.marginBottom = '8px';
    bad.textContent = '⚠ Could not read this card\'s comments (' + entry.commentsError +
      '), so this message does not know what has already been chased.';
    p.appendChild(bad);
  } else if (entry.history && !entry.history.known && entry.commentsRead === 0) {
    const none = document.createElement('div');
    none.className = 'meta';
    none.style.marginBottom = '8px';
    none.textContent = '🗒 No comments on this card yet.';
    p.appendChild(none);
  }


  if (entry.hiddenCount) {
    const rest = document.createElement('details');
    rest.className = 'meta';
    rest.style.marginBottom = '8px';
    const sum = document.createElement('summary');
    sum.style.cursor = 'pointer';
    sum.textContent = entry.hiddenCount + ' other checklist items on this card (not chased)';
    rest.appendChild(sum);
    const body = document.createElement('div');
    body.style.marginTop = '5px';
    const shown = {};
    body.textContent = (entry.missing || []).filter((m) => {
      const k = m.toLowerCase();
      if (shown[k]) return false;
      shown[k] = 1;
      return !asks.some((a) => (a.examples || []).indexOf(m) !== -1);
    }).join(' · ');
    rest.appendChild(body);
    p.appendChild(rest);
  }

  const ta = document.createElement('textarea');
  ta.className = 'msg';
  ta.value = entry.text || '';
  ta.disabled = !!entry.sent;
  ta.rows = 1;
  ta.addEventListener('change', async () => { entry.text = ta.value; await persist(); });
  ta.addEventListener('input', () => grow(ta));
  p.appendChild(ta);
  /* show the whole message rather than clipping it half way through a line */
  setTimeout(() => grow(ta), 0);

  const row = document.createElement('div');
  row.className = 'row';

  if (entry.sent) {
    const done = document.createElement('span');
    done.className = 'okmsg';
    done.textContent = '✓ Posted to ' + (entry.cardName || 'the card');
    row.appendChild(done);
  } else {
    const send = document.createElement('button');
    send.className = 'btn go';
    send.textContent = 'Send this one';
    send.addEventListener('click', () => sendOne(entry, row, send));
    row.appendChild(send);

    if (entry.shortLink) {
      const open = document.createElement('a');
      open.className = 'meta';
      open.href = 'https://trello.com/c/' + entry.shortLink;
      open.target = '_blank';
      open.textContent = 'open card ↗';
      row.appendChild(open);
    }
  }

  const st = document.createElement('span');
  st.className = 'meta';
  st.dataset.role = 'status';
  row.appendChild(st);
  p.appendChild(row);
  return p;
}

async function sendOne(entry, row, btn) {
  const st = row.querySelector('[data-role=status]');
  if (!entry.cardId) { st.textContent = 'Pick a card first.'; return; }
  const text = (entry.text || '').trim();
  if (!text) { st.textContent = 'Nothing to send.'; return; }
  if (btn) btn.disabled = true;
  st.className = 'meta';
  st.textContent = 'Posting…';
  const res = await QA.replyToCard(entry.cardId, text);
  if (res && res.ok) {
    entry.sent = true;
    entry.sentAt = Date.now();
    await persist();
    render();
    return true;
  }
  if (btn) btn.disabled = false;
  st.className = 'warn';
  st.textContent = QA.replyErrorMessage(res);
  return false;
}

/* two cards fit equally well — ask rather than guess at a client's card */
function chooserBlock(entry) {
  const p = document.createElement('div');
  p.className = 'panel off';

  const head = document.createElement('div');
  head.className = 'chead';
  const name = document.createElement('div');
  name.className = 'cname';
  name.textContent = entry.client + (entry.code ? ' ' + entry.code : '');
  head.appendChild(name);
  const when = document.createElement('div');
  when.className = 'cwhen';
  when.textContent = QA.whenLabel(entry) || 'next week';
  if (entry.dateMs) when.title = new Date(entry.dateMs).toDateString();
  head.appendChild(when);
  p.appendChild(head);

  const w = document.createElement('div');
  w.className = 'cmiss';
  w.textContent = entry.candidates.length + ' cards fit — which one?';
  p.appendChild(w);

  const row = document.createElement('div');
  row.className = 'row';
  entry.candidates.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = c.name;
    b.addEventListener('click', async () => {
      entry.cardId = c.id;
      entry.cardName = c.name;
      entry.shortLink = c.shortLink || '';
      entry.candidates = [];
      const found = QA.relevantAsks(entry.missing);
      entry.asks = found.asks;
      entry.hiddenCount = found.hidden;
      entry.text = QA.buildCardMessage(entry, (DRAFT && DRAFT.admin) || '');
      entry.include = true;
      await persist();
      render();
    });
    row.appendChild(b);
  });
  const skip = document.createElement('button');
  skip.className = 'btn';
  skip.textContent = 'Neither';
  skip.addEventListener('click', async () => {
    entry.candidates = [];
    await persist();
    render();
  });
  row.appendChild(skip);
  p.appendChild(row);

  const note = document.createElement('div');
  note.className = 'meta';
  note.style.marginTop = '8px';
  note.textContent = 'Nothing is posted until you pick one. The documents outstanding will be read from whichever card you choose.';
  p.appendChild(note);
  return p;
}

function leftovers() {
  const box = el('leftovers');
  const un = (DRAFT && DRAFT.entries || []).filter((e) => !e.cardId && !(e.candidates || []).length);
  if (!un.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = '';
  const l = document.createElement('div');
  l.className = 'unmatched';
  l.innerHTML = '';
  const title = document.createElement('b');
  title.textContent = 'No card found for: ';
  l.appendChild(title);
  l.appendChild(document.createTextNode(un.map((e) => e.client + (e.day ? ' (' + e.day + ')' : '')).join(', ')));
  box.appendChild(l);
  const hint = document.createElement('div');
  hint.className = 'meta';
  hint.style.marginTop = '6px';
  hint.textContent = 'Nothing will be posted for these. Usually it means no card carries that client name with the same QTM number.';
  box.appendChild(hint);
}

function render() {
  setHeader();
  const box = el('cards');
  box.innerHTML = '';
  if (DRAFT && DRAFT.problem) {
    const w = document.createElement('div');
    w.className = 'panel warn';
    w.textContent = DRAFT.problem;
    box.appendChild(w);
  }
  undecided().forEach((e) => box.appendChild(chooserBlock(e)));
  matched().forEach((e, i) => box.appendChild(cardBlock(e, i)));
  if (!matched().length && !undecided().length && !(DRAFT && DRAFT.problem)) {
    const p = document.createElement('div');
    p.className = 'panel meta';
    p.textContent = 'Nothing matched a card. Press “Rebuild from calendar”.';
    box.appendChild(p);
  }
  leftovers();
}

el('send-all').addEventListener('click', async () => {
  const list = toSend();
  if (!list.length) return;
  el('send-all').disabled = true;
  let done = 0;
  let failed = 0;
  for (const entry of list) {
    el('status').textContent = 'Posting ' + (done + failed + 1) + ' of ' + list.length + '…';
    const res = await QA.replyToCard(entry.cardId, (entry.text || '').trim());
    if (res && res.ok) {
      entry.sent = true;
      entry.sentAt = Date.now();
      done++;
    } else {
      entry.lastError = QA.replyErrorMessage(res);
      failed++;
    }
    await persist();
    await new Promise((r) => setTimeout(r, 400));   // be gentle with Trello
  }
  render();
  el('status').textContent = 'Posted ' + done + ' of ' + list.length +
    (failed ? ' · ' + failed + ' failed, still listed above' : '');
});

el('rebuild').addEventListener('click', () => {
  el('status').textContent = 'Reading your calendar…';
  el('rebuild').disabled = true;
  tell({ type: 'prepareFollowup' }, (d) => {
    el('rebuild').disabled = false;
    el('status').textContent = d ? 'Ready.' : 'Could not build a draft.';
    if (d) { DRAFT = d; render(); }
  });
});

/* settings */
const hourSel = el('hour');
for (let h = 5; h <= 20; h++) {
  const o = document.createElement('option');
  o.value = String(h);
  o.textContent = ((h % 12) || 12) + (h < 12 ? 'am' : 'pm');
  hourSel.appendChild(o);
}

const wantedBox = el('wanted');
QA.getFollowup().then((cfg) => {
  const on = cfg.wanted || QA.WANTED_DOCS.map((d) => d.id);
  QA.WANTED_DOCS.forEach((d) => {
    const lab = document.createElement('label');
    lab.className = 'meta';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = on.indexOf(d.id) !== -1;
    cb.addEventListener('change', async () => {
      const picked = [...wantedBox.querySelectorAll('input')]
        .map((x, i) => (x.checked ? QA.WANTED_DOCS[i].id : null)).filter(Boolean);
      await QA.setFollowup({ wanted: picked });
    });
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(' ' + d.label));
    wantedBox.appendChild(lab);
  });
});

const gcalSel = el('gcal');
QA.GOOGLE_ACCOUNTS.forEach((a) => {
  const o = document.createElement('option');
  o.value = String(a.index);
  o.textContent = a.label + '  (u/' + a.index + ')';
  gcalSel.appendChild(o);
});
gcalSel.addEventListener('change', () => QA.setFollowup({ gcalUser: parseInt(gcalSel.value, 10) }));
el('chasedays').addEventListener('change', () => QA.setFollowup({ chaseDays: parseInt(el('chasedays').value, 10) }));

el('require').addEventListener('change', () => QA.setFollowup({ requireText: el('require').value.trim() }));
el('skip').addEventListener('change', () => QA.setFollowup({ skipText: el('skip').value.trim() }));

QA.getFollowup().then((cfg) => {
  el('require').value = cfg.requireText || '';
  el('skip').value = cfg.skipText || '';
  gcalSel.value = String(typeof cfg.gcalUser === 'number' ? cfg.gcalUser : 0);
  el('chasedays').value = String(typeof cfg.chaseDays === 'number' ? cfg.chaseDays : 1);
  el('admin').value = cfg.admin || '';
  el('weekday').value = String(cfg.weekday);
  hourSel.value = String(cfg.hour);
  el('on').checked = cfg.on !== false;
});

el('admin').addEventListener('change', () => QA.setFollowup({ admin: el('admin').value.trim().replace(/^@/, '') }));
el('weekday').addEventListener('change', () => {
  QA.setFollowup({ weekday: parseInt(el('weekday').value, 10) }).then(() => tell({ type: 'rescheduleFollowup' }));
});
hourSel.addEventListener('change', () => {
  QA.setFollowup({ hour: parseInt(hourSel.value, 10) }).then(() => tell({ type: 'rescheduleFollowup' }));
});
el('on').addEventListener('change', () => {
  QA.setFollowup({ on: el('on').checked }).then(() => tell({ type: 'rescheduleFollowup' }));
});


chrome.storage.local.get({ followupDraft: null }).then((got) => {
  DRAFT = got.followupDraft;
  render();
});

