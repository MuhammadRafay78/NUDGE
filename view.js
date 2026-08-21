/* One mention at a time. Shared by the popup and the side panel. */

const MODE = document.body.classList.contains('panel') ? 'panel' : 'popup';
const el = (id) => document.getElementById(id);

/* Fire-and-forget messaging. With no listener (panel closed, worker asleep)
   Chrome rejects the promise — that is expected, not a failure, so swallow it.
   A plain try/catch cannot: the rejection is asynchronous. */
function tell(msg, cb) {
  try {
    const p = cb ? chrome.runtime.sendMessage(msg, cb) : chrome.runtime.sendMessage(msg);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) {}
}


let TAB = null;
let LAST = null;      // last scan
let QUEUE = [];       // what you still have to deal with
let IDX = 0;          // which one you're looking at
let VIEW_MODE = 'active';   // 'active' | 'done' — exclusive, never mixed in one list
let RANGE_MODE = 'today';   // Today by default — the last week rarely matters
let GROUP = 'all';   // all | qtm | tpr | cdp
let ASK = null;       // { question, summary } while showing an answer
let UNDO = null;      // last thing marked done
/* What you have dismissed in this session, kept separately from storage.
   A background poll can start before you press Done and finish after: it then
   carries the older "still new" answer and the item pops back. This is the
   last word on it, so a poll in flight can never undo a click. */
const DISMISSED = new Map();   // hash -> true = handled, false = brought back
let TIMER = null;     // keeps itself up to date, so you never press refresh

const AVATAR_COLORS = ['#0ea5e9', '#8b5cf6', '#059669', '#d946ef', '#f59e0b', '#ef4444', '#14b8a6', '#6366f1'];

function initialsOf(name) {
  const n = (name || '').trim();
  if (!n) return '•';
  const parts = n.replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean);
  if (!parts.length) return '•';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function colorFor(name) {
  let h = 0;
  const s = name || '?';
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function svg(paths, cls) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.innerHTML = paths;
  if (cls) s.setAttribute('class', cls);
  return s;
}

/* ---------- data ---------- */

function buildQueue() {
  const seen = new Set();
  const all = [];
  (LAST && LAST.results || []).forEach((r) => {
    (r.items || []).forEach((i) => {
      if (seen.has(i.hash)) return;
      seen.add(i.hash);
      i.result = r;   // keep the reference: Done must mutate the real item
      /* a fresh scan can be older than your last click — your click wins */
      if (DISMISSED.has(i.hash)) i.isNew = !DISMISSED.get(i.hash);
      all.push(i);
    });
  });
  if (REPLYING && !all.some((i) => i.hash === REPLYING)) REPLYING = null;
  const inScope = all.filter((i) => QA.inGroup(i, GROUP));
  const list = VIEW_MODE === 'done' ? inScope.filter((i) => !i.isNew) : inScope.filter((i) => i.isNew);
  /* Order: unread first, then whatever the triage made of it, then newest.
     Note what this does NOT do — nothing is filtered out by its bucket. An item
     the model called FYI still sits in the queue; it just sits further down. */
  const rank = (i) => {
    const b = TRIAGE.get(i.hash);
    return b && typeof b.rank === 'number' ? b.rank : 1.5;   // unsorted lands mid-pack
  };
  list.sort((a, b) =>
    ((b.isNew ? 1 : 0) - (a.isNew ? 1 : 0)) ||
    (rank(a) - rank(b)) ||
    ((b.when || 0) - (a.when || 0)));
  QUEUE = list;
  if (IDX >= QUEUE.length) IDX = Math.max(0, QUEUE.length - 1);
}

/* ---------- triage ----------
   hash -> { key, label, rank, why }. Empty when it is off, which is the default,
   and empty when Gemini fails — in both cases the queue behaves exactly as it
   always has. */
const TRIAGE = new Map();
let TRIAGE_NOTE = '';
let TRIAGING = false;
/* Sorting runs from draw(), and finishing it draws again. Without these two, a
   rejected key means: draw, ask, fail, draw, ask, fail — forever, as fast as the
   network allows. Anything attempted is remembered, and a failure stands down
   for a minute rather than retrying on every repaint. */
const TRIAGE_TRIED = new Set();
let TRIAGE_QUIET_UNTIL = 0;
const TRIAGE_COOLDOWN_MS = 60000;

async function runTriage() {
  if (TRIAGING) return;
  if (Date.now() < TRIAGE_QUIET_UNTIL) return;
  const todo = QUEUE.filter((i) => !TRIAGE.has(i.hash) && !TRIAGE_TRIED.has(i.hash));
  if (!todo.length) return;
  const cfg = await QA.getTriage();
  if (!cfg.enabled || !cfg.apiKey) return;

  TRIAGING = true;
  let changed = false;
  try {
    todo.forEach((i) => TRIAGE_TRIED.add(i.hash));
    let got = await QA.triageMentions(todo, cfg);

    /* Google retires models. When the saved one goes, find a current one and
       carry on — he should not have to visit Settings to get his sorting back. */
    if (!got.ok && /no longer offered/.test(got.why || '')) {
      const list = await QA.listGeminiModels(cfg.apiKey);
      if (list.ok && list.models.length) {
        const next = list.models[0].id;
        await QA.setTriage({ model: next });
        got = await QA.triageMentions(todo, Object.assign({}, cfg, { model: next }));
        if (got.ok) TRIAGE_NOTE = '';
      }
    }

    if (got.ok) {
      Object.keys(got.buckets).forEach((h) => TRIAGE.set(h, got.buckets[h]));
      TRIAGE_NOTE = '';
      changed = true;
    } else if (got.why && got.why !== 'off' && got.why !== 'no key') {
      TRIAGE_NOTE = got.why;
      TRIAGE_QUIET_UNTIL = Date.now() + TRIAGE_COOLDOWN_MS;
      changed = true;
    }
  } catch (e) {
    TRIAGE_NOTE = 'Sorting failed: ' + ((e && e.message) || e);
    TRIAGE_QUIET_UNTIL = Date.now() + TRIAGE_COOLDOWN_MS;
    changed = true;
  } finally {
    TRIAGING = false;
  }
  if (changed) draw();
}

function handledCount() {
  let n = 0;
  (LAST && LAST.results || []).forEach((r) => { n += (r.items || []).filter((i) => !i.isNew).length; });
  return n;
}

function hiddenOldCount() {
  let n = 0;
  (LAST && LAST.results || []).forEach((r) => { n += r.hiddenOld || 0; });
  return n;
}

/* ---------- render ---------- */

function filterSummary() {
  const date = RANGE_MODE === 'custom' ? QA.customDateLabel() : QA.rangeFor(RANGE_MODE).label;
  return GROUP === 'all' ? date : date + ' · ' + QA.groupFor(GROUP).label;
}

function setFilterButton() {
  const lab = el('filter-label');
  if (lab) lab.textContent = filterSummary();
  const dot = el('filter-dot');
  const changed = !(RANGE_MODE === 'today' && GROUP === 'all');
  if (dot) dot.hidden = !changed;
}

function popOpen() {
  return !el('pop').hidden;
}

function togglePop(open) {
  const pop = el('pop');
  const btn = el('filter-btn');
  const want = typeof open === 'boolean' ? open : pop.hidden;
  pop.hidden = !want;
  btn.classList.toggle('open', want);
  btn.setAttribute('aria-expanded', want ? 'true' : 'false');
}

function drawDates() {
  const box = el('dates');
  if (!box) return;
  box.innerHTML = '';
  QA.UI_RANGES.forEach((mode) => {
    const b = document.createElement('button');
    b.className = 'chip' + (RANGE_MODE === mode ? ' on' : '');
    b.textContent = QA.rangeFor(mode).label;
    b.addEventListener('click', async () => {
      if (RANGE_MODE === mode) return;
      RANGE_MODE = mode;
      IDX = 0;
      await chrome.storage.sync.set({ rangeMode: RANGE_MODE });
      ASK = null;
      showAsk();
      togglePop(false);
      refresh({ quiet: true });
    });
    box.appendChild(b);
  });

  // any single day, not just the presets above
  const pick = document.createElement('input');
  pick.type = 'date';
  pick.className = 'chip date-pick' + (RANGE_MODE === 'custom' ? ' on' : '');
  pick.title = 'Pick any date';
  const existing = QA.getCustomDate();
  if (existing) pick.value = existing;
  pick.addEventListener('click', (e) => e.stopPropagation());
  pick.addEventListener('change', async () => {
    if (!pick.value) return;
    QA.setCustomDate(pick.value);
    RANGE_MODE = 'custom';
    IDX = 0;
    await chrome.storage.sync.set({ rangeMode: RANGE_MODE, customDate: pick.value });
    ASK = null;
    showAsk();
    togglePop(false);
    refresh({ quiet: true });
  });
  box.appendChild(pick);
}

function drawChips() {
  const box = el('chips');
  box.innerHTML = '';
  const all = [];
  (LAST && LAST.results || []).forEach((r) => (r.items || []).forEach((i) => all.push(i)));
  QA.GROUPS.forEach((g) => {
    const b = document.createElement('button');
    b.className = 'chip' + (GROUP === g.id ? ' on' : '');
    b.textContent = g.label;
    const n = all.filter((i) => i.isNew && QA.inGroup(i, g.id)).length;
    if (n) {
      const s = document.createElement('small');
      s.textContent = n;
      b.appendChild(s);
    }
    b.addEventListener('click', async () => {
      GROUP = g.id;
      IDX = 0;
      await chrome.storage.sync.set({ group: GROUP });
      togglePop(false);
      draw();
    });
    box.appendChild(b);
  });
}

function setTop() {
  const c = el('count');
  /* on the Canopy tab the header should say who you are looking at, not how many
     Trello mentions are waiting — that number is on the Trello tab */
  if (VIEW === 'canopy') {
    if (!TAB || !QA.isCanopy(TAB.url)) c.textContent = 'Canopy';
    else if (!CANOPY) c.textContent = 'Reading…';
    else if (!CANOPY.ok) c.textContent = 'Canopy';
    else c.textContent = CANOPY.client || ('Client ' + (CANOPY.clientId || ''));
    el('prev').disabled = true;
    el('next').disabled = true;
    el('clear-all').textContent = UNDO ? 'Undo' : 'Clear all';
    return;
  }
  if (ASK) {
    c.textContent = QUEUE.length ? QUEUE.length + (QUEUE.length === 1 ? ' answer' : ' answers') : 'No answer';
  } else if (!LAST) {
    c.textContent = 'Checking…';
  } else if (!QUEUE.length) {
    c.textContent = VIEW_MODE === 'done' ? 'Nothing done yet' : 'Nothing new';
  } else {
    c.textContent = QUEUE.length + ' need you' + (GROUP === 'all' ? '' : ' in ' + QA.groupFor(GROUP).label);
    if (QUEUE.length > 1) {
      const s = document.createElement('small');
      s.textContent = '  ' + (IDX + 1) + ' of ' + QUEUE.length;
      c.appendChild(s);
    }
  }
  el('prev').disabled = IDX <= 0;
  el('next').disabled = IDX >= QUEUE.length - 1;
  el('filter').textContent = VIEW_MODE === 'done' ? '← Back to new' : 'Done';
  el('clear-all').textContent = UNDO ? 'Undo' : 'Clear all';
}

function emptyState() {
  const d = document.createElement('div');
  d.className = 'empty';
  const big = document.createElement('div');
  big.className = 'big';
  const small = document.createElement('div');
  small.className = 'small';

  if (ASK) {
    big.textContent = 'Nothing matches';
    small.textContent = ASK.summary || '';
  } else if (VIEW_MODE === 'done') {
    big.textContent = 'Nothing done yet';
    small.textContent = 'Nothing has been marked Done in this time range.';
  } else {
    const handled = handledCount();
    const older = hiddenOldCount();
    big.textContent = GROUP === 'all' ? 'Nothing new' : 'Nothing new in ' + QA.groupFor(GROUP).label;
    const bits = [];
    if (GROUP !== 'all') {
      const others = [];
      (LAST && LAST.results || []).forEach((r) => (r.items || []).forEach((i) => {
        if (i.isNew && !QA.inGroup(i, GROUP)) others.push(i);
      }));
      if (others.length) bits.push(others.length + ' waiting under All');
    }
    if (handled) bits.push(handled + ' already dealt with');
    const readAway = (LAST && LAST.results || []).reduce((n, r) => n + (r.readElsewhere || 0), 0);
    if (readAway) bits.push(readAway + ' already read in Trello');
    if (older) {
      const rangeLabel = RANGE_MODE === 'custom' ? QA.customDateLabel() : QA.rangeFor(RANGE_MODE).label;
      bits.push(older + ' outside ' + rangeLabel.toLowerCase());
    }
    small.textContent = bits.length ? bits.join(' · ') : 'Nobody has tagged you.';
  }
  d.appendChild(big);
  d.appendChild(small);
  return d;
}

/* ---------- deadlines ----------
   The due date usually arrives with the mention, because the notifications
   request asks Trello to attach the card. When it does not, look it up — but only
   for the card actually on screen, and only once. cardId -> {due, dueComplete}. */
const DUE = new Map();
let DUE_ASKING = null;

function dueOf(item) {
  if (item && typeof item.due !== 'undefined' && item.due !== null) {
    return { due: item.due, dueComplete: !!item.dueComplete };
  }
  if (item && item.cardId && DUE.has(item.cardId)) return DUE.get(item.cardId);
  return null;
}

async function findDue(item) {
  if (!item || !item.cardId) return;
  if (typeof item.due !== 'undefined') return;      // Trello already answered, even with null
  if (DUE.has(item.cardId) || DUE_ASKING === item.cardId) return;
  DUE_ASKING = item.cardId;
  try {
    const got = await QA.dueForCard(item.cardId);
    if (got && got.ok) {
      DUE.set(item.cardId, { due: got.due, dueComplete: got.dueComplete });
      if (got.due) draw();
    } else {
      DUE.set(item.cardId, { due: null, dueComplete: false });   // do not ask again
    }
  } catch (e) {
    DUE.set(item.cardId, { due: null, dueComplete: false });
  } finally {
    DUE_ASKING = null;
  }
}

let REPLYING = null;   // hash of the item whose reply box is open

function mentionToken(ta) {
  const upto = (ta.value || '').slice(0, ta.selectionStart || 0);
  const m = upto.match(/(?:^|\s)@([\p{L}\p{N}_.-]*)$/u);
  if (!m) return null;
  return { q: m[1], start: (ta.selectionStart || 0) - m[1].length - 1 };
}

function replyBox(item, card) {
  const box = document.createElement('div');
  box.className = 'reply';

  let attachedImage = null;   // { file, previewUrl } | null

  let people = QA.mergePeople(
    item.actorUser ? [{ username: item.actorUser, fullName: item.actor || item.actorUser }] : [],
    QA.knownPeople(LAST)
  );
  let picks = [];
  let sel = 0;

  const quick = document.createElement('div');
  quick.className = 'quick';
  QA.QUICK_REPLIES.forEach((q) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = q;
    b.addEventListener('click', () => {
      const at = item.actorUser ? '@' + item.actorUser + ' ' : '';
      ta.value = at + q;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      closeList();
    });
    quick.appendChild(b);
  });
  box.appendChild(quick);

  const wrap = document.createElement('div');
  wrap.className = 'reply-wrap';
  const ta = document.createElement('textarea');
  ta.className = 'reply-in';
  ta.rows = 2;
  ta.placeholder = 'Reply to ' + (item.actor || 'them') + '… type @ to tag someone, or drop an image';
  // tag them back by default — a reply without it often goes unread
  if (item.actorUser) ta.value = '@' + item.actorUser + ' ';
  wrap.appendChild(ta);

  const list = document.createElement('div');
  list.className = 'mention-list';
  list.hidden = true;
  wrap.appendChild(list);
  box.appendChild(wrap);

  const preview = document.createElement('div');
  preview.className = 'img-preview';
  preview.hidden = true;
  box.appendChild(preview);

  function clearImage() {
    if (attachedImage) URL.revokeObjectURL(attachedImage.previewUrl);
    attachedImage = null;
    paintPreview();
  }

  function paintPreview() {
    preview.innerHTML = '';
    if (!attachedImage) { preview.hidden = true; return; }
    preview.hidden = false;
    const img = document.createElement('img');
    img.src = attachedImage.previewUrl;
    preview.appendChild(img);
    const name = document.createElement('span');
    name.className = 'img-preview-name';
    name.textContent = attachedImage.file.name;
    preview.appendChild(name);
    const x = document.createElement('button');
    x.className = 'img-preview-x';
    x.title = 'Remove image';
    x.textContent = '×';
    x.addEventListener('click', clearImage);
    preview.appendChild(x);
  }

  function tryAttach(file) {
    const err = QA.imageAttachError(file);
    if (err) {
      status.className = 'reply-status bad';
      status.textContent = err;
      return;
    }
    status.className = 'reply-status';
    status.textContent = '';
    if (attachedImage) URL.revokeObjectURL(attachedImage.previewUrl);
    attachedImage = { file: file, previewUrl: URL.createObjectURL(file) };
    paintPreview();
  }

  wrap.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; wrap.classList.add('drag-over'); });
  wrap.addEventListener('dragleave', () => wrap.classList.remove('drag-over'));
  wrap.addEventListener('drop', (e) => {
    e.preventDefault();
    wrap.classList.remove('drag-over');
    const file = QA.pickImageFromTransfer(e.dataTransfer);
    if (!file) { status.className = 'reply-status bad'; status.textContent = 'Drop an image file.'; return; }
    tryAttach(file);
  });
  ta.addEventListener('paste', (e) => {
    const file = QA.pickImageFromClipboard(e.clipboardData);
    if (!file) return;   // let a normal text paste through
    e.preventDefault();
    tryAttach(file);
  });

  function closeList() {
    list.hidden = true;
    picks = [];
    sel = 0;
  }

  function drawList() {
    list.innerHTML = '';
    picks.forEach((p, i) => {
      const row = document.createElement('button');
      row.className = 'mention-row' + (i === sel ? ' on' : '');
      const u = document.createElement('b');
      u.textContent = '@' + p.username;
      row.appendChild(u);
      const f = document.createElement('span');
      f.textContent = p.fullName;
      row.appendChild(f);
      row.addEventListener('mousedown', (e) => { e.preventDefault(); insert(p); });
      list.appendChild(row);
    });
    list.hidden = !picks.length;
  }

  function insert(p) {
    const tok = mentionToken(ta);
    const at = tok ? tok.start : (ta.selectionStart || 0);
    const before = ta.value.slice(0, at);
    const after = ta.value.slice(ta.selectionStart || 0);
    ta.value = before + '@' + p.username + ' ' + after;
    const pos = (before + '@' + p.username + ' ').length;
    ta.focus();
    ta.setSelectionRange(pos, pos);
    closeList();
  }

  function maybeSuggest() {
    const tok = mentionToken(ta);
    if (!tok) { closeList(); return; }
    picks = QA.matchPeople(people, tok.q);
    sel = 0;
    drawList();
  }

  const row = document.createElement('div');
  row.className = 'acts';
  const send = document.createElement('button');
  send.className = 'btn go';
  send.textContent = 'Send reply';
  const attachBtn = document.createElement('button');
  attachBtn.className = 'btn attach-btn';
  attachBtn.title = 'Attach an image';
  attachBtn.textContent = '📎';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.hidden = true;
  const cancel = document.createElement('button');
  cancel.className = 'btn';
  cancel.textContent = 'Cancel';
  const status = document.createElement('span');
  status.className = 'reply-status';
  row.appendChild(send);
  row.appendChild(attachBtn);
  row.appendChild(fileInput);
  row.appendChild(cancel);
  row.appendChild(status);
  box.appendChild(row);

  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (file) tryAttach(file);
  });

  cancel.addEventListener('click', () => { REPLYING = null; draw(); });

  async function doSend() {
    const text = (ta.value || '').trim();
    const textIsJustMention = text === '@' + (item.actorUser || '');
    if ((!text || textIsJustMention) && !attachedImage) { ta.focus(); return; }
    send.disabled = true;
    cancel.disabled = true;
    status.className = 'reply-status';
    status.textContent = attachedImage ? 'Uploading image…' : 'Sending…';
    /* Text left as-is even when it's just the default "@user " mention — with
       an image attached that mention is still what makes Trello notify them,
       it only gets blocked outright above when there's nothing else to send. */
    const res = await QA.replyToCard(item.cardId, text, attachedImage && attachedImage.file);
    if (res && res.ok) {
      status.textContent = 'Sent';
      REPLYING = null;
      await markDone(item, false);
      QA.syncBoardAfterReply(item.cardId);   // best-effort: move any matching board card to Done too
    } else {
      send.disabled = false;
      cancel.disabled = false;
      status.className = 'reply-status bad';
      status.textContent = QA.replyErrorMessage(res);
    }
  }

  send.addEventListener('click', doSend);
  ta.addEventListener('input', maybeSuggest);
  ta.addEventListener('blur', () => setTimeout(closeList, 120));
  ta.addEventListener('keydown', (e) => {
    const open = !list.hidden && picks.length;
    if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : picks.length - 1)) % picks.length;
      drawList();
      return;
    }
    if (open && (e.key === 'Enter' || e.key === 'Tab')) { e.preventDefault(); insert(picks[sel]); return; }
    if (open && e.key === 'Escape') { e.preventDefault(); closeList(); return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    if (e.key === 'Escape') { REPLYING = null; draw(); }
  });

  setTimeout(() => {
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, 0);

  // fill in the rest of the board's members quietly, once
  QA.cardMembers(item.cardId).then((m) => {
    if (m && m.length) people = QA.mergePeople(people, m);
  });

  return box;
}

function cardFor(item) {
  const card = document.createElement('div');
  card.className = 'card';

  const who = document.createElement('div');
  who.className = 'who';
  const person = item.actor || '';
  const av = document.createElement('div');
  av.className = 'av';
  av.style.background = colorFor(person || item.text);
  av.textContent = initialsOf(person);
  who.appendChild(av);

  const idBlock = document.createElement('div');
  const nm = document.createElement('div');
  nm.className = 'name';
  nm.textContent = person || 'On this page';
  idBlock.appendChild(nm);
  const sub = document.createElement('div');
  sub.className = 'sub';
  const bits = [];
  if (item.when) bits.push(QA.ago(item.when));
  if (item.unread) bits.push('unread in Trello');
  if (!item.isNew && item.firstSeen) bits.push('done ' + QA.ago(item.firstSeen));
  sub.textContent = bits.join(' · ') || 'no time given';
  if (item.when) sub.title = new Date(item.when).toLocaleString();
  idBlock.appendChild(sub);
  who.appendChild(idBlock);

  /* say where this came from. Obvious with two sources, less so with three. */
  const src = document.createElement('span');
  src.className = 'src trello';
  src.textContent = 'Trello';
  src.title = (item.boardName || 'Trello') + (item.listName ? ' · ' + item.listName : '');
  who.appendChild(src);

  /* what the triage made of it, when it is switched on. A label, never a filter. */
  const bucket = TRIAGE.get(item.hash);
  if (bucket && bucket.label) {
    const b = document.createElement('span');
    b.className = 'bucket ' + bucket.key;
    b.textContent = bucket.label;
    b.title = bucket.why || '';
    who.appendChild(b);
  }

  if (item.isNew) {
    const dot = document.createElement('div');
    dot.className = 'dot-new';
    dot.title = 'New since you last looked';
    who.appendChild(dot);
  }
  card.appendChild(who);

  if (bucket && bucket.why) {
    const w = document.createElement('div');
    w.className = 'bucket-why';
    w.textContent = bucket.why;
    card.appendChild(w);
  }

  const q = document.createElement('div');
  q.className = 'quote';
  /* tidied for reading only — item.text keeps Trello's original, which is what
     gets matched when posting a reaction to the real comment */
  q.textContent = QA.tidyCommentText(item.text);
  q.title = item.text;
  card.appendChild(q);

  if (item.cardName) {
    const p = document.createElement('div');
    p.className = 'place';
    p.appendChild(svg('<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="7" y1="9" x2="17" y2="9"/><line x1="7" y1="13" x2="13" y2="13"/>'));
    const t = document.createElement('span');
    t.textContent = item.cardName;
    p.appendChild(t);

    /* the card's deadline, next to the card it belongs to */
    const d = dueOf(item);
    const lab = d ? QA.dueLabel(d.due, d.dueComplete) : null;
    if (lab) {
      const chip = document.createElement('span');
      chip.className = 'due ' + lab.tone;
      chip.textContent = (lab.done ? '✓ ' : '') + lab.text;
      chip.title = new Date(d.due).toLocaleString() +
        (lab.done ? ' — marked complete on the card' : '');
      p.appendChild(chip);
    }
    card.appendChild(p);
  }

  if (REPLYING === item.hash) {
    card.appendChild(replyBox(item, card));
    return card;
  }

  /* Sometimes the right answer is an emoji, not a sentence — "let us know once
     the notes are updated" deserves a 👍, not a paragraph. */
  if (item.cardId) {
    const react = document.createElement('div');
    react.className = 'react';
    QA.REACTIONS.forEach((r) => {
      const b = document.createElement('button');
      b.className = 'emo';
      b.textContent = r.emoji;
      b.title = r.label + ' — react on this comment in Trello';
      b.dataset.emoji = r.emoji;
      if ((item.reacted || []).indexOf(r.emoji) !== -1) b.classList.add('on');
      b.addEventListener('click', async () => {
        const note = react.querySelector('[data-role=rstatus]');
        [...react.querySelectorAll('button')].forEach((x) => { x.disabled = true; });
        note.className = 'rnote';
        note.textContent = 'Reacting…';
        const res = await QA.reactToMention(item, r);
        [...react.querySelectorAll('button')].forEach((x) => { x.disabled = false; });
        if (!res || !res.ok) {
          note.className = 'rnote bad';
          note.textContent = QA.reactErrorMessage(res);
          return;
        }
        b.classList.add('on');
        item.reacted = (item.reacted || []).concat([r.emoji]);
        note.className = 'rnote ok';
        note.textContent = res.already ? r.emoji + ' already there' : r.emoji + ' added';
        if (item.isNew) setTimeout(() => markDone(item, false), 550);
      });
      react.appendChild(b);
    });
    const note = document.createElement('span');
    note.className = 'rnote';
    note.dataset.role = 'rstatus';
    react.appendChild(note);
    card.appendChild(react);
  }

  const acts = document.createElement('div');
  acts.className = 'acts';

  if (item.cardId) {
    const rep = document.createElement('button');
    rep.className = 'btn go';
    rep.textContent = 'Reply';
    rep.title = 'Post a comment straight back to this card';
    rep.addEventListener('click', () => { REPLYING = item.hash; draw(); });
    acts.appendChild(rep);
  }

  if (item.href) {
    const open = document.createElement('button');
    open.className = 'btn' + (item.cardId ? '' : ' go');
    open.textContent = 'Open card';
    open.title = 'Open it in your Trello tab, the way clicking the card does';
    open.addEventListener('click', async () => {
      open.disabled = true;
      open.textContent = 'Opening…';
      /* Opens the card inside your existing Trello tab instead of reloading
         whatever page you happen to be on. Anything that goes wrong is shown on
         the button — a dead button that does nothing is the worst outcome. */
      let res = null;
      try {
        res = await QA.openCardSmart(item);
      } catch (e) {
        res = { ok: false, error: (e && e.message) || String(e) };
      }
      /* Always say what happened. A button that silently does nothing is the
         one outcome there is no excuse for. */
      const note = card.querySelector('[data-role=openerr]') || document.createElement('div');
      note.dataset.role = 'openerr';
      card.appendChild(note);

      if (!res || !res.ok) {
        open.disabled = false;
        open.textContent = 'Open card';
        note.className = 'err';
        note.textContent = 'Could not open it: ' + ((res && res.error) || 'unknown') +
          ' — trying a new tab.';
        try { await chrome.tabs.create({ url: item.href }); } catch (e2) {}
        return;
      }
      note.className = 'meta';
      note.style.padding = '6px 4px 0';
      note.textContent = '↗ ' + (res.how || 'opened');
      open.textContent = 'Open card';
      open.disabled = false;
      if (item.isNew) await markDone(item, false);
      if (MODE === 'popup') window.close();
    });
    acts.appendChild(open);
  } else {
    const find = document.createElement('button');
    find.className = 'btn go';
    find.textContent = 'Find on page';
    find.addEventListener('click', () => {
      chrome.scripting.executeScript({ target: { tabId: TAB.id }, func: scrollToText, args: [item.text] }).catch(() => {});
    });
    acts.appendChild(find);
  }

  /* deliberately file this one on the Kanban board — independent of whether
     it was ever pushed to a phone, and works on old/already-seen mentions too */
  const board = document.createElement('button');
  board.className = 'btn';
  board.textContent = '+ Board';
  board.title = 'Add this to the Kanban board (Settings > Mobile notifications)';
  board.addEventListener('click', async () => {
    board.disabled = true;
    board.textContent = 'Adding…';
    const d = dueOf(item);
    const lab = d ? QA.dueLabel(d.due, d.dueComplete) : null;
    const notifId = item.hash && item.hash.indexOf('tn:') === 0 ? item.hash.slice(3) : (item.notificationId || '');
    const res = await QA.fileCard({
      title: (item.actor || 'Someone') + ' tagged you', body: item.text || '', url: item.href || '',
      context: item.cardName || '', due: lab ? lab.text : '',
      dueAt: d ? d.due || '' : '', dueComplete: d ? !!d.dueComplete : false,
      cardId: item.cardId || '', notifId: notifId, actorUser: item.actorUser || ''
    });
    const note = card.querySelector('[data-role=boardnote]') || document.createElement('div');
    note.dataset.role = 'boardnote';
    card.appendChild(note);
    if (res && res.ok) {
      note.className = 'meta';
      note.style.padding = '6px 4px 0';
      note.textContent = '✓ Added to board';
      board.textContent = 'Added ✓';
      setTimeout(() => { board.textContent = '+ Board'; board.disabled = false; }, 1500);
    } else {
      note.className = 'err';
      note.textContent = 'Could not add: ' + ((res && res.error) || 'unknown error');
      board.textContent = '+ Board';
      board.disabled = false;
    }
  });
  acts.appendChild(board);

  const done = document.createElement('button');
  done.className = 'btn';
  done.textContent = item.isNew ? 'Done' : 'Bring back';
  done.addEventListener('click', () => markDone(item, !item.isNew));
  acts.appendChild(done);

  if (QUEUE.length > 1) {
    const skip = document.createElement('button');
    skip.className = 'btn';
    skip.textContent = 'Skip';
    skip.addEventListener('click', () => { REPLYING = null; IDX = Math.min(IDX + 1, QUEUE.length - 1); draw(); });
    acts.appendChild(skip);
  }

  card.appendChild(acts);

  if (LEDGER_OPEN === item.cardId) card.appendChild(ledgerBox(item));

  return card;
}

/* ---------- the document ledger ----------
   Everything this client has been asked for, everything that has arrived, and
   anything they are waiting on from us — read off the card's own comment thread.
   cardId -> { loading } | { rows, via, note } | { error } */
const LEDGER = new Map();
let LEDGER_OPEN = null;

async function loadLedger(item) {
  if (!item || !item.cardId) return;
  if (LEDGER.has(item.cardId)) return;          // already have it, or already asking
  LEDGER.set(item.cardId, { loading: true });
  draw();
  let got;
  try {
    got = await QA.cardLedger(item.cardId, { admin: 'pauleleazar1' });
  } catch (e) {
    got = { ok: false, why: String((e && e.message) || e), rows: [] };
  }
  LEDGER.set(item.cardId, got);
  draw();
}

function ledgerBox(item) {
  const box = document.createElement('div');
  box.className = 'ledger';
  const state = LEDGER.get(item.cardId);

  if (!state || state.loading) {
    const l = document.createElement('div');
    l.className = 'cfm';
    l.textContent = 'Reading the whole thread…';
    box.appendChild(l);
    return box;
  }

  if (!state.ok) {
    const e = document.createElement('div');
    e.className = 'cfm';
    e.textContent = '⚠ ' + (state.why || 'Could not read this card.');
    box.appendChild(e);
    return box;
  }

  if (!state.rows.length) {
    const n = document.createElement('div');
    n.className = 'cfm';
    n.textContent = state.comments
      ? 'Nothing about documents in ' + state.comments + ' comment' + (state.comments === 1 ? '' : 's') + '.'
      : 'No comments on this card yet.';
    box.appendChild(n);
    return box;
  }

  /* grouped, and in the order that matters: what is outstanding first */
  [['waiting', 'Still waiting on the client'],
    ['theyasked', 'They are waiting on us'],
    ['received', 'Received']].forEach(([key, title]) => {
    const rows = state.rows.filter((r) => r.status === key);
    if (!rows.length) return;
    const h = document.createElement('div');
    h.className = 'bucket-head';
    h.textContent = title + ' · ' + rows.length;
    box.appendChild(h);
    rows.forEach((r) => {
      const line = document.createElement('div');
      line.className = 'lrow';
      const nm = document.createElement('div');
      nm.className = 'lname';
      nm.textContent = r.item;
      line.appendChild(nm);
      const meta = document.createElement('div');
      meta.className = 'cfm';
      /* the date and the name come off the comment, so they can be trusted */
      meta.textContent = [r.at ? QA.shortDate(r.at) : '', r.by, r.said]
        .filter(Boolean).join(' · ');
      meta.title = r.quote || '';
      line.appendChild(meta);
      box.appendChild(line);
    });
  });

  const foot = document.createElement('div');
  foot.className = 'cfm';
  foot.style.marginTop = '8px';
  foot.textContent = 'From ' + state.comments + ' comment' + (state.comments === 1 ? '' : 's') +
    ' · ' + (state.via === 'Gemini' ? 'sorted by Gemini' : state.via) +
    (state.note ? ' · ' + state.note : '');
  box.appendChild(foot);
  return box;
}

/* ---------- the two sections ----------
   The Canopy read used to sit above the mentions and take over the panel. It is
   reference material about where you are standing, not something that needs you,
   so it gets its own tab and the mentions get theirs. */
const VIEWS = ['trello', 'canopy', 'gmail'];
let VIEW = 'trello';

async function loadView() {
  try {
    const got = await chrome.storage.local.get({ nudgeView: 'trello' });
    VIEW = VIEWS.indexOf(got.nudgeView) > -1 ? got.nudgeView : 'trello';
  } catch (e) { VIEW = 'trello'; }
}

function setView(next, opts) {
  VIEW = VIEWS.indexOf(next) > -1 ? next : 'trello';
  try { chrome.storage.local.set({ nudgeView: VIEW }); } catch (e) { /* not fatal */ }
  if (!opts || !opts.quiet) draw();
  if (VIEW === 'canopy' && !CANOPY) readCanopy(false).then(draw).catch(() => {});
  if (VIEW === 'gmail' && !GMAIL) readGmail(false).then(draw).catch(() => {});
}

function drawTabs() {
  const tabs = el('tabs');
  if (!tabs) return;
  const onCanopy = !!(TAB && QA.isCanopy(TAB.url));

  [['trello', 'tab-trello'], ['canopy', 'tab-canopy'], ['gmail', 'tab-gmail']].forEach(([name, id]) => {
    const b = el(id);
    if (!b) return;
    b.classList.toggle('on', VIEW === name);
    b.setAttribute('aria-selected', VIEW === name ? 'true' : 'false');
  });

  /* Trello: how many are waiting. Canopy: how many are waiting to be FILED —
     the file count is not news, the unfiled ones are. */
  const t = el('tnum-trello');
  if (t) {
    const n = QUEUE.length;
    t.textContent = n;
    t.hidden = !n;
    t.className = 'tnum';
  }
  const c = el('tnum-canopy');
  if (c) {
    const inbox = (CANOPY && CANOPY.ok && (CANOPY.inbox || []).length) || 0;
    if (inbox) {
      c.textContent = inbox;
      c.className = 'tnum';
      c.hidden = false;
    } else if (onCanopy && CANOPY && CANOPY.ok) {
      c.textContent = ((CANOPY.files || []).filter((f) => f.isFile).length) || 0;
      c.className = 'tnum quiet';
      c.hidden = false;
    } else {
      c.hidden = true;
    }
  }
  const g = el('tnum-gmail');
  if (g) {
    const unread = (GMAIL && GMAIL.ok && (GMAIL.inboxRows || []).filter((r) => r.unread).length) || 0;
    g.textContent = unread;
    g.className = 'tnum quiet';
    g.hidden = !unread;
  }
}

/* the filter row and the Ask box belong to the mentions, not to Canopy or Gmail */
function showTrelloChrome(on) {
  /* These were set with the `hidden` attribute, which did nothing: .bar and .ask
     both set `display: flex` in the stylesheet, and a class beats the browser's
     own [hidden] rule. The filter row and the Ask box stayed on screen on the
     Canopy tab. view.css now carries [hidden] { display: none !important }, and
     the property is set here as well so it is true in both senses. */
  ['.bar', '.ask', '#answer'].forEach((sel) => {
    const n = document.querySelector(sel);
    if (!n) return;
    n.hidden = !on;
    n.style.display = on ? '' : 'none';
  });
}

function canopyTabBody() {
  const card = canopyCard();
  if (card) return card;
  const d = document.createElement('div');
  d.className = 'empty';
  const big = document.createElement('div');
  big.className = 'big';
  const small = document.createElement('div');
  small.className = 'small';
  big.textContent = 'Not on a Canopy page';
  small.textContent = 'Open a client in Canopy and this shows what is in front of you — '
    + 'the folder, its files, and anything still sitting in the File Inbox.';
  d.appendChild(big);
  d.appendChild(small);
  return d;
}

function gmailTabBody() {
  const card = gmailCard();
  if (card) return card;
  const d = document.createElement('div');
  d.className = 'empty';
  const big = document.createElement('div');
  big.className = 'big';
  const small = document.createElement('div');
  small.className = 'small';
  big.textContent = 'Not on Gmail';
  small.textContent = 'Open a thread in Gmail and ask about the client it is about — '
    + 'the answer only ever uses what is actually on that page.';
  d.appendChild(big);
  d.appendChild(small);
  return d;
}

function draw() {
  buildQueue();
  drawDates();
  drawChips();
  setFilterButton();
  setTop();
  drawTabs();
  showTrelloChrome(VIEW === 'trello');

  const wrap = el('wrap');
  wrap.innerHTML = '';

  if (VIEW === 'canopy') {
    wrap.appendChild(canopyTabBody());
    return;
  }

  if (VIEW === 'gmail') {
    wrap.appendChild(gmailTabBody());
    return;
  }

  if (LAST && LAST.error) {
    const e = document.createElement('div');
    e.className = 'err';
    e.textContent = LAST.error;
    wrap.appendChild(e);
    return;
  }
  if (!QUEUE.length) { wrap.appendChild(emptyState()); return; }
  wrap.appendChild(cardFor(QUEUE[IDX]));

  /* if the triage is on and something is unsorted, sort it in the background */
  runTriage().catch(() => {});
  /* and if this card's deadline did not come with the mention, go and get it */
  findDue(QUEUE[IDX]).catch(() => {});

  /* Anything Trello counted as read but which never passed through here gets a
     pointer rather than silence. */
  const elsewhere = (LAST && LAST.results || []).reduce((n, r) => n + (r.readElsewhere || 0), 0);
  if (elsewhere && VIEW_MODE !== 'done') {
    const n = document.createElement('button');
    n.className = 'link';
    n.style.marginTop = '10px';
    n.textContent = elsewhere + (elsewhere === 1 ? ' mention was' : ' mentions were') +
      ' already read in Trello — show ' + (elsewhere === 1 ? 'it' : 'them');
    n.addEventListener('click', () => { VIEW_MODE = 'done'; IDX = 0; draw(); });
    wrap.appendChild(n);
  }

  if (DONE_NOTE) {
    const n = document.createElement('div');
    n.className = 'cfm';
    n.style.marginTop = '8px';
    n.textContent = '⚠ ' + DONE_NOTE;
    wrap.appendChild(n);
  }

  if (TRIAGE_NOTE) {
    const n = document.createElement('div');
    n.className = 'cfm';
    n.style.marginTop = '8px';
    n.textContent = '⚠ Sorting is off right now — ' + TRIAGE_NOTE +
      ' Your list is unaffected.';
    wrap.appendChild(n);
  }
}

/* set when Trello could not be told, so the panel can say so */
let DONE_NOTE = '';

async function markDone(item, bringBack) {
  DISMISSED.set(item.hash, !bringBack);   // set this first: it wins over any poll
  await QA.setItemsSeen(item.result.snapKey, [item.hash], !bringBack);
  item.isNew = !!bringBack;
  item.firstSeen = bringBack ? null : Date.now();
  item.result.newCount = (item.result.items || []).filter((i) => i.isNew).length;
  item.result.neverChecked = false;
  UNDO = bringBack ? null : item;
  DONE_NOTE = '';
  draw();
  tell({ type: 'refreshBadge', tabId: TAB.id, url: TAB.url });
  /* and don't let it pop as a desktop notification after you have dealt with it */
  tell({ type: 'handled', hash: item.hash, undo: !!bringBack });

  /* Record it in Trello as well as here. This is the half that survives the
     extension being reinstalled — the local note goes with it, Trello's does not. */
  try {
    const res = await QA.rememberHandled(item, !!bringBack);
    if (!res || !res.ok) {
      if (res && res.error === 'not a Trello notification') return;   // nothing to record
      DONE_NOTE = QA.handledErrorMessage(res);
      draw();
    }
  } catch (e) {
    DONE_NOTE = 'Marked done here, but Trello could not be told (' + ((e && e.message) || e) + ').';
    draw();
  }
}

/* ---------- ask ---------- */

function scrollToText(text) {
  const needle = (text || '').slice(0, 60).trim();
  if (!needle) return;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  let n;
  while ((n = walker.nextNode())) {
    if (n.nodeValue && n.nodeValue.indexOf(needle) !== -1) {
      const t = n.parentElement;
      if (!t) return;
      t.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const old = t.style.outline;
      t.style.outline = '3px solid #f97316';
      setTimeout(() => { t.style.outline = old; }, 2500);
      return;
    }
  }
}

function showAsk() {
  const box = el('answer');
  box.innerHTML = '';
  if (!ASK) return;
  const line = document.createElement('div');
  const b = document.createElement('b');
  b.textContent = ASK.question + ' — ';
  line.appendChild(b);
  line.appendChild(document.createTextNode(ASK.summary));
  box.appendChild(line);
  const back = document.createElement('button');
  back.className = 'link';
  back.textContent = 'back to mentions';
  back.style.marginTop = '6px';
  back.addEventListener('click', () => { ASK = null; IDX = 0; showAsk(); refresh(); });
  box.appendChild(back);
}

function askNow() {
  const q = (el('ask-input').value || '').trim();
  if (!q || !LAST) return;
  const res = QA.localAnswer(q, LAST, { names: QA.ME, sinceMs: QA.rangeFor(RANGE_MODE).since() });
  ASK = { question: q, summary: res.summary };
  // answers become the thing you page through, same card layout
  LAST = Object.assign({}, LAST, {
    results: [{
      rule: { id: 'ask', name: q },
      snapKey: 'ask|' + q,
      items: res.items.map((i) => Object.assign({}, i, { isNew: true })),
      newCount: res.items.length, total: res.items.length, hiddenOld: 0, lastChecked: Date.now()
    }]
  });
  IDX = 0;
  showAsk();
  draw();
}

/* ---------- Canopy ----------
   When you are on a Canopy page, show what is actually on it: which client,
   where you are in their folders, the files in front of you, and anything still
   sitting in the File Inbox. Read-only — it never changes anything in Canopy. */

let CANOPY = null;        // the last read
let CANOPY_AT = 0;
/* which folded lists you have opened, so a refresh does not close them again */
const FOLDS = new Map();

async function readCanopy(force) {
  if (!TAB || !QA.isCanopy(TAB.url)) { CANOPY = null; return; }
  if (!force && CANOPY && Date.now() - CANOPY_AT < 4000) return;
  CANOPY = await QA.canopyRead(TAB.id);
  CANOPY_AT = Date.now();
}

function row(label, value, cls) {
  const d = document.createElement('div');
  d.className = 'crow' + (cls ? ' ' + cls : '');
  const a = document.createElement('span');
  a.className = 'ck';
  a.textContent = label;
  const b = document.createElement('span');
  b.className = 'cv';
  b.textContent = value;
  d.appendChild(a);
  d.appendChild(b);
  return d;
}

function canopyCard() {
  if (!CANOPY) return null;
  const c = document.createElement('div');
  c.className = 'card canopy';

  const head = document.createElement('div');
  head.className = 'chead';
  const tag = document.createElement('span');
  tag.className = 'ctag';
  tag.textContent = 'CANOPY';
  head.appendChild(tag);

  const who = document.createElement('div');
  who.className = 'cwho';
  who.textContent = CANOPY.client || (CANOPY.clientId ? 'Client ' + CANOPY.clientId : 'Canopy');
  head.appendChild(who);

  if (CANOPY.clientType) {
    const ty = document.createElement('span');
    ty.className = 'ctype';
    ty.textContent = CANOPY.clientType;
    head.appendChild(ty);
  }
  c.appendChild(head);

  if (!CANOPY.ok) {
    const e = document.createElement('div');
    e.className = 'err';
    e.textContent = CANOPY.error || 'Could not read the Canopy page.';
    c.appendChild(e);
    /* show exactly why, per tab and per world — a generic message told us nothing */
    if ((CANOPY.problems || []).length) {
      const pre = document.createElement('pre');
      pre.className = 'debug';
      pre.textContent = CANOPY.problems.join('\n');
      c.appendChild(pre);
    }
    const again = document.createElement('button');
    again.className = 'btn';
    again.textContent = 'Try again';
    again.addEventListener('click', async () => {
      again.textContent = 'Reading…';
      await readCanopy(true);
      draw();
    });
    const acts0 = document.createElement('div');
    acts0.className = 'acts';
    acts0.appendChild(again);
    c.appendChild(acts0);
    return c;
  }

  /* Where you are. The breadcrumb reads best when it is there; the highlighted
     folder in the tree is the fallback. "Section files" off the URL is a last
     resort and says almost nothing. */
  if ((CANOPY.crumbs || []).length > 1) {
    c.appendChild(row('Folder', CANOPY.crumbs.slice(1).join(' / ')));
  } else if (CANOPY.folder) {
    c.appendChild(row('Folder', CANOPY.folder));
  } else if (CANOPY.section) {
    c.appendChild(row('Section', CANOPY.section));
  }

  /* ---------- folded lists ----------
     A folder with 39 files made this section enormous. Each list is now one line
     you can open. The File Inbox opens by default, because unfiled documents are
     the part that actually needs doing. */
  const fileRow = (name, meta, title) => {
    const d = document.createElement('div');
    d.className = 'cfile';
    const n = document.createElement('div');
    n.className = 'cfn';
    n.textContent = name;
    n.title = title || name;
    d.appendChild(n);
    if (meta) {
      const m = document.createElement('div');
      m.className = 'cfm';
      m.textContent = meta;
      d.appendChild(m);
    }
    return d;
  };

  const foldable = (key, label, count, openByDefault, fill) => {
    const open = FOLDS.has(key) ? FOLDS.get(key) : openByDefault;
    const head = document.createElement('button');
    head.className = 'fold' + (open ? ' open' : '');
    const caret = document.createElement('span');
    caret.className = 'caret';
    caret.textContent = '▶';
    const lab = document.createElement('span');
    lab.className = 'flabel';
    lab.textContent = label;
    head.appendChild(caret);
    head.appendChild(lab);
    c.appendChild(head);

    /* Built only when open. A folded list of 39 files should not be 39 rows of
       hidden markup — that is the same weight, just invisible. */
    const body = document.createElement('div');
    body.hidden = !open;
    let filled = false;
    if (open && count) { fill(body); filled = true; }
    c.appendChild(body);

    head.addEventListener('click', () => {
      const now = body.hidden;
      if (now && count && !filled) { fill(body); filled = true; }
      body.hidden = !now;
      head.classList.toggle('open', now);
      FOLDS.set(key, now);
    });
    return head;
  };

  const files = (CANOPY.files || []).filter((f) => f.isFile);
  const folders = (CANOPY.files || []).filter((f) => !f.isFile);

  foldable(
    'files',
    files.length
      ? files.length + ' file' + (files.length === 1 ? '' : 's') + ' here' +
        (folders.length ? ' · ' + folders.length + ' folder' + (folders.length === 1 ? '' : 's') : '')
      : 'No files in this folder',
    files.length,
    false,
    (body) => {
      files.slice(0, 40).forEach((f) => {
        body.appendChild(fileRow(f.name, [f.added, f.addedBy].filter(Boolean).join(' · ')));
      });
      if (files.length > 40) {
        const more = document.createElement('div');
        more.className = 'cfm';
        more.textContent = '+ ' + (files.length - 40) + ' more';
        body.appendChild(more);
      }
    }
  );

  /* the File Inbox — things nobody has filed yet */
  if ((CANOPY.inbox || []).length) {
    const head = foldable(
      'inbox',
      '📥 File inbox: ' + CANOPY.inbox.length + ' waiting to be filed',
      CANOPY.inbox.length,
      true,
      (body) => {
        CANOPY.inbox.slice(0, 20).forEach((f) => {
          body.appendChild(fileRow(f.name, [f.date, f.who].filter(Boolean).join(' · ')));
        });
      }
    );
    head.querySelector('.flabel').classList.add('warnish');
  }

  const acts = document.createElement('div');
  acts.className = 'acts';

  const copy = document.createElement('button');
  copy.className = 'btn';
  copy.textContent = 'Copy list';
  copy.addEventListener('click', async () => {
    const lines = [];
    lines.push((CANOPY.client || 'Canopy') + (CANOPY.clientType ? ' (' + CANOPY.clientType + ')' : ''));
    if ((CANOPY.crumbs || []).length > 1) lines.push(CANOPY.crumbs.slice(1).join(' / '));
    lines.push('');
    files.forEach((f) => lines.push('- ' + f.name + (f.added ? '  (' + f.added + (f.addedBy ? ', ' + f.addedBy : '') + ')' : '')));
    if ((CANOPY.inbox || []).length) {
      lines.push('');
      lines.push('File inbox (' + CANOPY.inbox.length + '):');
      CANOPY.inbox.forEach((f) => lines.push('- ' + f.name + (f.date ? '  (' + f.date + ')' : '')));
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy list'; }, 1400);
    } catch (e) { copy.textContent = 'Could not copy'; }
  });
  acts.appendChild(copy);

  const again = document.createElement('button');
  again.className = 'btn';
  again.textContent = 'Re-read';
  again.addEventListener('click', async () => {
    again.textContent = 'Reading…';
    await readCanopy(true);
    draw();
  });
  acts.appendChild(again);

  /* Hands the page over as a file, from the tab the reader just read.
     Copying it by hand out of DevTools picked up the wrong Canopy tab. */
  const dump = document.createElement('button');
  dump.className = 'btn';
  dump.textContent = 'Save page HTML';
  dump.title = 'Saves what the reader can see on this page, for working out why something reads oddly.\n' +
    'It contains this client\'s file names — it is yours to share or not.';
  dump.addEventListener('click', async () => {
    dump.disabled = true;
    dump.textContent = 'Saving…';
    const got = await QA.canopyDump(TAB && TAB.id);
    if (!got || !got.ok) {
      dump.textContent = 'Could not save';
      const pre = document.createElement('pre');
      pre.className = 'debug';
      pre.textContent = (got && (got.error || (got.problems || []).join('\n'))) || 'no answer from the page';
      c.appendChild(pre);
      return;
    }
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const blob = new Blob([got.html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'canopy-page-' + stamp + '.html';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    dump.textContent = 'Saved to Downloads';
    const note = document.createElement('div');
    note.className = 'csub';
    note.textContent = Math.round(got.html.length / 1024) + ' KB · ' +
      (/shadow roots found: (\d+)/.exec(got.html) || [0, '?'])[1] + ' shadow roots';
    c.appendChild(note);
  });
  acts.appendChild(dump);

  const dbg = document.createElement('button');
  dbg.className = 'btn';
  dbg.textContent = 'What can it see?';
  dbg.addEventListener('click', () => {
    const pre = document.createElement('pre');
    pre.className = 'debug';
    pre.textContent = [
      'url      ' + CANOPY.url,
      'title    ' + CANOPY.title,
      'clientId ' + (CANOPY.clientId || '(none)') + '   section: ' + (CANOPY.section || '(none)'),
      'client   ' + (CANOPY.client || '(none)') + '   type: ' + (CANOPY.clientType || '(none)'),
      'crumbs   ' + ((CANOPY.crumbs || []).join(' / ') || '(none)'),
      'headings ' + ((CANOPY.headings || []).slice(0, 8).join(' | ') || '(none)'),
      'read by  ' + (CANOPY.via || '?') +
        (CANOPY.filesVia ? '   list via: ' + CANOPY.filesVia : '   list via: (nothing read)') +
        (CANOPY.trouble && CANOPY.trouble.length ? '   trouble: ' + CANOPY.trouble.join('; ') : ''),
      'folder   ' + (CANOPY.folder || '(none)'),
      'files    ' + ((CANOPY.files || []).length),
      'inbox    ' + ((CANOPY.inbox || []).length),
      'folders  ' + ((CANOPY.folders || []).map((f) => f.name + (f.count == null ? '' : ' ' + f.count)).slice(0, 12).join(', ') || '(none)'),
      'shape    ' + ((CANOPY.shape || []).join('\n         ') || '(not recorded)')
    ].join('\n');
    c.appendChild(pre);
    dbg.disabled = true;
  });
  acts.appendChild(dbg);

  c.appendChild(acts);
  return c;
}

/* ---------- Gmail ----------
   When you are on Gmail, show what is actually on the screen — the open
   thread's subject and who is on it, or the visible rows if you are looking
   at a list — and let you ask about the client it concerns. The answer only
   ever uses this same read, never anything fetched separately. Read-only. */

let GMAIL = null;
let GMAIL_AT = 0;
let GMAIL_ANSWER = null;   // { question, text } | { question, error } | null

async function readGmail(force) {
  if (!TAB || !QA.isGmail(TAB.url)) { GMAIL = null; GMAIL_ANSWER = null; return; }
  if (!force && GMAIL && Date.now() - GMAIL_AT < 4000) return;
  GMAIL = await QA.gmailRead(TAB.id);
  GMAIL_AT = Date.now();
}

function gmailCard() {
  if (!GMAIL) return null;
  const c = document.createElement('div');
  c.className = 'card gmail';

  const head = document.createElement('div');
  head.className = 'chead';
  const tag = document.createElement('span');
  tag.className = 'ctag';
  tag.textContent = 'GMAIL';
  head.appendChild(tag);

  const who = document.createElement('div');
  who.className = 'cwho';
  who.textContent = GMAIL.ok && GMAIL.threadOpen
    ? (GMAIL.subject || '(no subject read)')
    : GMAIL.ok ? 'Inbox / list view' : 'Gmail';
  head.appendChild(who);
  c.appendChild(head);

  if (!GMAIL.ok) {
    const e = document.createElement('div');
    e.className = 'err';
    e.textContent = GMAIL.error || 'Could not read this Gmail page.';
    c.appendChild(e);
    if ((GMAIL.problems || []).length) {
      const pre = document.createElement('pre');
      pre.className = 'debug';
      pre.textContent = GMAIL.problems.join('\n');
      c.appendChild(pre);
    }
    const again = document.createElement('button');
    again.className = 'btn';
    again.textContent = 'Try again';
    again.addEventListener('click', async () => {
      again.textContent = 'Reading…';
      await readGmail(true);
      draw();
    });
    const acts0 = document.createElement('div');
    acts0.className = 'acts';
    acts0.appendChild(again);
    c.appendChild(acts0);
    return c;
  }

  if ((GMAIL.participants || []).length) {
    c.appendChild(row('With', GMAIL.participants.join(', ')));
  }
  if (GMAIL.threadOpen) {
    c.appendChild(row('Read', GMAIL.messages.length + ' message' + (GMAIL.messages.length === 1 ? '' : 's') + ' on screen'));
  } else if ((GMAIL.inboxRows || []).length) {
    const unread = GMAIL.inboxRows.filter((r) => r.unread).length;
    c.appendChild(row('Read', GMAIL.inboxRows.length + ' row' + (GMAIL.inboxRows.length === 1 ? '' : 's') +
      (unread ? ' · ' + unread + ' unread' : '')));
  }

  /* ---- ask about the client this page is open to ---- */
  const askWrap = document.createElement('div');
  askWrap.className = 'gask';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Ask: what does this client still owe us?';
  askWrap.appendChild(input);
  const askBtn = document.createElement('button');
  askBtn.className = 'btn go';
  askBtn.textContent = 'Ask';
  askWrap.appendChild(askBtn);
  c.appendChild(askWrap);

  const answerEl = document.createElement('div');
  answerEl.className = 'ganswer';
  if (GMAIL_ANSWER) {
    input.value = GMAIL_ANSWER.question;
    if (GMAIL_ANSWER.error) {
      answerEl.classList.add('bad');
      answerEl.textContent = GMAIL_ANSWER.error;
    } else {
      answerEl.textContent = GMAIL_ANSWER.text;
    }
  }
  c.appendChild(answerEl);

  const ask = async () => {
    const q = input.value.trim();
    if (!q) return;
    askBtn.disabled = true;
    answerEl.className = 'ganswer';
    answerEl.textContent = 'Thinking…';
    try {
      const res = await QA.answerAboutGmail(q, GMAIL);
      GMAIL_ANSWER = { question: q, text: res.text };
      answerEl.textContent = res.text;
    } catch (e) {
      const msg = (e && e.message) || 'Could not get an answer.';
      GMAIL_ANSWER = { question: q, error: msg };
      answerEl.className = 'ganswer bad';
      answerEl.textContent = msg;
    } finally {
      askBtn.disabled = false;
    }
  };
  askBtn.addEventListener('click', ask);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ask(); } });

  const acts = document.createElement('div');
  acts.className = 'acts';
  const again = document.createElement('button');
  again.className = 'btn';
  again.textContent = 'Re-read';
  again.addEventListener('click', async () => {
    again.textContent = 'Reading…';
    GMAIL_ANSWER = null;
    await readGmail(true);
    draw();
  });
  acts.appendChild(again);
  c.appendChild(acts);

  return c;
}

/* ---------- scan ---------- */

async function refresh(opts) {
  const quiet = !!(opts && opts.quiet);
  if (quiet && REPLYING) return;   // never redraw while you're mid-reply
  TAB = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (!TAB) return;
  if (!quiet) UNDO = null;
  if (!quiet) el('count').textContent = 'Checking…';

  /* if this is Canopy or Gmail, read the page too — it is the reason you opened the panel */
  try { await readCanopy(!quiet); } catch (e) { CANOPY = null; }
  try { await readGmail(!quiet); } catch (e) { GMAIL = null; }

  /* Chrome blocks extensions on chrome:// pages, the Web Store and so on — but
     your Trello mentions have nothing to do with the page you are looking at, so
     fetch those on their own rather than giving up. */
  const scriptable = /^https?:|^file:/i.test(TAB.url || '');

  // hold your place across a background refresh
  const wasHash = QUEUE[IDX] && QUEUE[IDX].hash;
  try {
    const fresh = scriptable
      ? await QA.runScan(TAB.id, TAB.url, { rangeMode: RANGE_MODE })
      : await QA.mentionsOnly({ rangeMode: RANGE_MODE, url: TAB.url });
    if (ASK && quiet) return;          // don't yank an answer out from under you

    /* A background poll that failed to reach Trello must not replace a good list
       with an empty one — you would watch your mentions vanish for no reason. */
    const freshFailed = (fresh.results || []).some((r) => r.source === 'trello-api' && r.failed);
    const hadItems = (LAST && LAST.results || []).some((r) => (r.items || []).length);
    if (quiet && freshFailed && hadItems) { draw(); return; }

    LAST = fresh;
    if (quiet && wasHash) {
      buildQueue();
      const at = QUEUE.map((i) => i.hash).indexOf(wasHash);
      IDX = at === -1 ? 0 : at;
    } else {
      IDX = 0;
    }
  } catch (e) {
    if (quiet) return;                 // a failed background poll shouldn't blank the view
    LAST = { error: (e && e.message) || String(e), results: [] };
  }
  draw();
}

/* A look at the panel's own state, for diagnosing behaviour rather than markup.
   A function declaration on purpose: the panel's variables are block-scoped, so
   this is the only way anything outside can see them. */
function nudgeState() {
  return {
    view: VIEW,
    queue: QUEUE.map((i) => i.hash),
    buckets: QUEUE.map((i) => {
      const b = TRIAGE.get(i.hash);
      return { hash: i.hash, key: (b && b.key) || null, why: (b && b.why) || '' };
    }),
    triageNote: TRIAGE_NOTE,
    doneNote: DONE_NOTE,
    triageQuiet: TRIAGE_QUIET_UNTIL > Date.now(),
    triageTried: TRIAGE_TRIED.size,
    canopy: CANOPY ? { ok: CANOPY.ok, client: CANOPY.client, files: (CANOPY.files || []).length } : null,
    folds: [...FOLDS.entries()]
  };
}

function nudgeForgetTriage() {
  TRIAGE.clear();
  TRIAGE_TRIED.clear();
  TRIAGE_NOTE = '';
  TRIAGE_QUIET_UNTIL = 0;
}

/* ---------- wire up ---------- */

let WIRED = false;

async function wire() {
  if (WIRED) return;   // attach exactly once, however we got here
  WIRED = true;
  const pref = await chrome.storage.sync.get({ rangeMode: 'today', group: 'all', customDate: '' });
  const validModes = QA.UI_RANGES.concat(['custom']);
  RANGE_MODE = validModes.indexOf(pref.rangeMode) === -1 ? 'today' : pref.rangeMode;
  if (RANGE_MODE === 'custom') {
    if (pref.customDate) QA.setCustomDate(pref.customDate);
    else RANGE_MODE = 'today';   // custom picked but no date saved somehow — fall back rather than showing "any time"
  }
  GROUP = pref.group || 'all';
  await loadView();

  const ai = await QA.getAI();
  if (ai.enabled === false) document.querySelector('.ask').style.display = 'none';

  /* the two sections. Remembered, so opening the panel puts you back where you were. */
  const tabs = el('tabs');
  if (tabs) {
    tabs.addEventListener('click', (e) => {
      const b = e.target.closest ? e.target.closest('.tab') : null;
      if (!b || !b.dataset.view) return;
      REPLYING = null;
      setView(b.dataset.view);
    });
  }

  el('prev').addEventListener('click', () => { REPLYING = null; IDX = Math.max(0, IDX - 1); draw(); });
  el('next').addEventListener('click', () => { REPLYING = null; IDX = Math.min(QUEUE.length - 1, IDX + 1); draw(); });
  el('rescan').addEventListener('click', () => { ASK = null; showAsk(); refresh(); });
  /* Save whatever page he is looking at, so a reader can be written against the
     real markup instead of guessed at from a screenshot. */
  const savePage = el('savepage');
  if (savePage) {
    savePage.addEventListener('click', async () => {
      savePage.disabled = true;
      const was = savePage.title;
      savePage.title = 'Reading the page…';
      const got = await QA.dumpPage(TAB && TAB.id);
      savePage.disabled = false;
      savePage.title = was;
      const wrap = el('wrap');
      const note = document.createElement('div');
      note.className = 'cfm';
      note.style.marginTop = '8px';

      if (!got || !got.ok) {
        note.textContent = '⚠ Could not read this page. ' + ((got && got.problems) || []).join(' · ');
        wrap.appendChild(note);
        return;
      }
      let host = '';
      try { host = new URL(got.url).host.replace(/^www\./, ''); } catch (e) { host = 'page'; }
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      const blob = new Blob([got.html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = host + '-' + stamp + '.html';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);

      const kb = Math.round(got.html.length / 1024);
      const sh = (/shadow roots: (\d+)/.exec(got.html) || [0, '0'])[1];
      const fr = (/readable iframes: (\d+)/.exec(got.html) || [0, '0'])[1];
      note.textContent = 'Saved ' + a.download + ' · ' + kb + ' KB · ' +
        sh + ' shadow roots · ' + fr + ' readable iframes. ' +
        'It is in your Downloads and has been sent nowhere — this page\'s contents are ' +
        'in it, so it is yours to share or not.';
      wrap.appendChild(note);
    });
  }

  el('manage').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  });

  const panelBtn = el('open-panel');
  if (panelBtn) {
    panelBtn.addEventListener('click', async () => {
      try { await chrome.sidePanel.open({ tabId: TAB.id }); window.close(); } catch (e) {}
    });
  }

  el('filter-btn').addEventListener('click', (e) => { e.stopPropagation(); togglePop(); });
  el('pop').addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => { if (popOpen()) togglePop(false); });

  el('reset-filters').addEventListener('click', async () => {
    RANGE_MODE = 'today';
    GROUP = 'all';
    IDX = 0;
    await chrome.storage.sync.set({ rangeMode: RANGE_MODE, group: GROUP });
    togglePop(false);
    ASK = null;
    showAsk();
    refresh({ quiet: true });
  });

  el('followup-link').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('followup.html') });
  });

  el('board-link').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('board.html') });
  });

  el('ask-btn').addEventListener('click', askNow);
  el('ask-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); askNow(); } });

  el('filter').addEventListener('click', () => { VIEW_MODE = VIEW_MODE === 'done' ? 'active' : 'done'; IDX = 0; draw(); });

  el('clear-all').addEventListener('click', async () => {
    if (UNDO) { await markDone(UNDO, true); return; }
    for (const r of (LAST && LAST.results) || []) await QA.markSeen([r]);
    UNDO = null;
    IDX = 0;
    draw();
    tell({ type: 'refreshBadge', tabId: TAB.id, url: TAB.url });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && popOpen()) { togglePop(false); return; }
    if (document.activeElement === el('ask-input')) return;
    if (popOpen() || REPLYING) return;
    if (popOpen()) return;
    if (e.key === 'ArrowRight' || e.key === 'j') el('next').click();
    if (e.key === 'ArrowLeft' || e.key === 'k') el('prev').click();
    if (e.key === 'Enter' && QUEUE[IDX]) markDone(QUEUE[IDX], !QUEUE[IDX].isNew);
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'trelloUpdated') refresh({ quiet: true });
  });

  clearInterval(TIMER);
  TIMER = setInterval(() => refresh({ quiet: true }), 8000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh({ quiet: true });
  });
  window.addEventListener('focus', () => refresh({ quiet: true }));

  if (MODE === 'panel') {
    chrome.tabs.onActivated.addListener(() => { ASK = null; showAsk(); refresh(); });
    chrome.tabs.onUpdated.addListener((id, info) => {
      if (info.status === 'complete' && TAB && id === TAB.id) refresh();
    });
  }

  await refresh();
}

document.addEventListener('DOMContentLoaded', wire);
if (document.readyState !== 'loading') wire();  // script may load after DOMContentLoaded
