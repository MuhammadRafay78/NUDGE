/* Kanban board — same server + pairing code as the phone relay (Settings > Mobile notifications). */

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status');
const warnEl = document.getElementById('notConfigured');
const newTitle = document.getElementById('newTitle');
const addBtn = document.getElementById('addBtn');

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function mentionToken(ta) {
  const upto = (ta.value || '').slice(0, ta.selectionStart || 0);
  const m = upto.match(/(?:^|\s)@([\p{L}\p{N}_.-]*)$/u);
  if (!m) return null;
  return { q: m[1], start: (ta.selectionStart || 0) - m[1].length - 1 };
}

const LONG_BODY = 140;   // roughly where a 3-line clamp starts hiding text
const expanded = new Set();   // card ids currently showing full text, survives a refresh
let dragging = false;         // suppress auto-refresh mid-drag so the drop target doesn't vanish
let cardsById = {};            // last-rendered cards, for the reply box's cardId/actorUser
let replyingId = null;         // which card's reply box is open — suppresses auto-refresh too
const peopleCache = {};        // cardId -> [{username, fullName}], fetched once per open

function itemHtml(card) {
  const openLink = card.url ? '<a class="open" href="' + esc(card.url) + '" target="_blank" rel="noreferrer">Open &rarr;</a>' : '';
  const options = QA.BOARD_COLUMNS.map((c) =>
    '<option value="' + c.id + '"' + (c.id === card.column ? ' selected' : '') + '>' + c.label + '</option>'
  ).join('');
  const body = card.body || '';
  const long = body.length > LONG_BODY;
  const isOpen = expanded.has(card.id);
  const canReply = !!card.cardId;
  return (
    '<div class="item" data-id="' + esc(card.id) + '" draggable="true">' +
      '<div class="t">' + esc(card.title) + '</div>' +
      (card.context ? '<div class="ctx">' + esc(card.context) + '</div>' : '') +
      (card.due ? '<div class="due">' + esc(card.due) + '</div>' : '') +
      (body ? '<div class="b' + (isOpen ? '' : ' clamp') + '">' + esc(body) + '</div>' : '') +
      (long ? '<button class="more">' + (isOpen ? 'Show less' : 'Show more') + '</button>' : '') +
      '<div class="row2">' +
        '<span class="when">' + QA.ago(card.updatedAt || card.createdAt) + '</span>' +
        openLink +
        (canReply ? '<button class="reply-btn">' + (replyingId === card.id ? 'Cancel' : 'Reply') + '</button>' : '') +
        '<select class="move">' + options + '</select>' +
        '<button class="del" title="Delete">&times;</button>' +
      '</div>' +
      (replyingId === card.id ? replyBoxHtml(card) : '') +
    '</div>'
  );
}

function replyBoxHtml(card) {
  const quick = QA.QUICK_REPLIES.map((q) =>
    '<button class="chip" data-q="' + esc(q) + '">' + esc(q) + '</button>'
  ).join('');
  const defaultText = card.actorUser ? '@' + card.actorUser + ' ' : '';
  return (
    '<div class="reply">' +
      '<div class="quick">' + quick + '</div>' +
      '<div class="reply-wrap">' +
        '<textarea class="reply-in" rows="2" placeholder="Reply… type @ to tag someone">' + esc(defaultText) + '</textarea>' +
        '<div class="mention-list" hidden></div>' +
      '</div>' +
      '<div class="reply-acts">' +
        '<button class="btn go send-reply">Send reply</button>' +
        '<button class="btn cancel-reply">Cancel</button>' +
        '<span class="reply-status"></span>' +
      '</div>' +
    '</div>'
  );
}

function render(cards) {
  cardsById = {};
  cards.forEach((c) => { cardsById[c.id] = c; });
  if (replyingId && !cardsById[replyingId]) replyingId = null;   // card moved/deleted elsewhere

  boardEl.innerHTML = QA.BOARD_COLUMNS.map((col) => {
    const items = cards.filter((c) => c.column === col.id);
    return (
      '<div class="col" data-col="' + col.id + '">' +
        '<h2>' + col.label + ' <span class="n">' + items.length + '</span></h2>' +
        (items.length ? items.map(itemHtml).join('') : '<div class="empty">Nothing here.</div>') +
      '</div>'
    );
  }).join('');

  if (replyingId) {
    const ta = boardEl.querySelector('.item[data-id="' + CSS.escape(replyingId) + '"] .reply-in');
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }
}

boardEl.addEventListener('change', async (e) => {
  if (!e.target.classList.contains('move')) return;
  const id = e.target.closest('.item').dataset.id;
  try {
    await QA.moveCard(id, e.target.value);
    load();
  } catch (err) {
    statusEl.textContent = 'Could not move: ' + err.message;
  }
});

/* ---------- reply, including @mention autocomplete ---------- */

function closeMentionList(item) {
  const list = item.querySelector('.mention-list');
  if (list) { list.hidden = true; list.innerHTML = ''; list.dataset.picks = ''; }
}

function drawMentionList(item, picks, sel) {
  const list = item.querySelector('.mention-list');
  if (!list) return;
  list.innerHTML = picks.map((p, i) =>
    '<button class="mention-row' + (i === sel ? ' on' : '') + '" data-u="' + esc(p.username) + '">' +
      '<b>@' + esc(p.username) + '</b><span>' + esc(p.fullName) + '</span>' +
    '</button>'
  ).join('');
  list.hidden = !picks.length;
  list.dataset.picks = JSON.stringify(picks);
  list.dataset.sel = sel;
}

async function peopleFor(cardId) {
  if (peopleCache[cardId]) return peopleCache[cardId];
  const m = await QA.cardMembers(cardId);
  peopleCache[cardId] = m || [];
  return peopleCache[cardId];
}

function insertMention(ta, item, username) {
  const tok = mentionToken(ta);
  const at = tok ? tok.start : (ta.selectionStart || 0);
  const before = ta.value.slice(0, at);
  const after = ta.value.slice(ta.selectionStart || 0);
  ta.value = before + '@' + username + ' ' + after;
  const pos = (before + '@' + username + ' ').length;
  ta.focus();
  ta.setSelectionRange(pos, pos);
  closeMentionList(item);
}

async function maybeSuggest(ta, item, cardId) {
  const tok = mentionToken(ta);
  if (!tok) { closeMentionList(item); return; }
  const people = await peopleFor(cardId);
  const picks = QA.matchPeople(people, tok.q);
  drawMentionList(item, picks, 0);
}

async function sendReply(item, card) {
  const ta = item.querySelector('.reply-in');
  const status = item.querySelector('.reply-status');
  const sendBtn = item.querySelector('.send-reply');
  const cancelBtn = item.querySelector('.cancel-reply');
  const text = (ta.value || '').trim();
  if (!text || text === '@' + (card.actorUser || '')) { ta.focus(); return; }
  sendBtn.disabled = true;
  cancelBtn.disabled = true;
  status.className = 'reply-status';
  status.textContent = 'Sending…';
  const res = await QA.replyToCard(card.cardId, text);
  if (res && res.ok) {
    status.textContent = 'Sent';
    replyingId = null;
    try { await QA.moveCard(card.id, 'done'); } catch (e) {}
    load();
  } else {
    sendBtn.disabled = false;
    cancelBtn.disabled = false;
    status.className = 'reply-status bad';
    status.textContent = QA.replyErrorMessage(res);
  }
}

boardEl.addEventListener('click', async (e) => {
  if (e.target.classList.contains('more')) {
    const id = e.target.closest('.item').dataset.id;
    const b = e.target.previousElementSibling;
    const collapsed = b.classList.toggle('clamp');
    if (collapsed) expanded.delete(id); else expanded.add(id);
    e.target.textContent = collapsed ? 'Show more' : 'Show less';
    return;
  }

  if (e.target.classList.contains('reply-btn')) {
    const id = e.target.closest('.item').dataset.id;
    replyingId = replyingId === id ? null : id;
    render(Object.values(cardsById));
    return;
  }
  if (e.target.classList.contains('cancel-reply')) {
    replyingId = null;
    render(Object.values(cardsById));
    return;
  }
  if (e.target.classList.contains('send-reply')) {
    const item = e.target.closest('.item');
    await sendReply(item, cardsById[item.dataset.id]);
    return;
  }
  if (e.target.classList.contains('chip') && e.target.closest('.reply')) {
    const item = e.target.closest('.item');
    const card = cardsById[item.dataset.id];
    const ta = item.querySelector('.reply-in');
    const at = card.actorUser ? '@' + card.actorUser + ' ' : '';
    ta.value = at + e.target.dataset.q;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    closeMentionList(item);
    return;
  }
  if (e.target.closest('.mention-row')) {
    const item = e.target.closest('.item');
    const ta = item.querySelector('.reply-in');
    insertMention(ta, item, e.target.closest('.mention-row').dataset.u);
    return;
  }

  if (!e.target.classList.contains('del')) return;
  const id = e.target.closest('.item').dataset.id;
  try {
    await QA.deleteCard(id);
    load();
  } catch (err) {
    statusEl.textContent = 'Could not delete: ' + err.message;
  }
});

boardEl.addEventListener('mousedown', (e) => {
  // keep the textarea focused when clicking a mention suggestion
  if (e.target.closest('.mention-row')) e.preventDefault();
});

boardEl.addEventListener('input', (e) => {
  if (!e.target.classList.contains('reply-in')) return;
  const item = e.target.closest('.item');
  const card = cardsById[item.dataset.id];
  maybeSuggest(e.target, item, card.cardId);
});

boardEl.addEventListener('blur', (e) => {
  if (!e.target.classList.contains('reply-in')) return;
  const item = e.target.closest('.item');
  setTimeout(() => closeMentionList(item), 120);
}, true);

boardEl.addEventListener('keydown', (e) => {
  if (!e.target.classList.contains('reply-in')) return;
  const item = e.target.closest('.item');
  const list = item.querySelector('.mention-list');
  const picks = list && !list.hidden ? JSON.parse(list.dataset.picks || '[]') : [];
  const sel = list ? Number(list.dataset.sel || 0) : 0;
  const open = picks.length > 0;

  if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    drawMentionList(item, picks, (sel + (e.key === 'ArrowDown' ? 1 : picks.length - 1)) % picks.length);
    return;
  }
  if (open && (e.key === 'Enter' || e.key === 'Tab')) { e.preventDefault(); insertMention(e.target, item, picks[sel].username); return; }
  if (open && e.key === 'Escape') { e.preventDefault(); closeMentionList(item); return; }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(item, cardsById[item.dataset.id]); }
  if (e.key === 'Escape') { replyingId = null; render(Object.values(cardsById)); }
});

/* ---------- drag and drop between columns ---------- */

boardEl.addEventListener('dragstart', (e) => {
  const item = e.target.closest('.item');
  if (!item) return;
  e.dataTransfer.setData('text/plain', item.dataset.id);
  e.dataTransfer.effectAllowed = 'move';
  item.classList.add('dragging');
  dragging = true;
});

boardEl.addEventListener('dragend', (e) => {
  const item = e.target.closest('.item');
  if (item) item.classList.remove('dragging');
  boardEl.querySelectorAll('.col.drag-over').forEach((c) => c.classList.remove('drag-over'));
  dragging = false;
});

boardEl.addEventListener('dragover', (e) => {
  const col = e.target.closest('.col');
  if (!col) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  col.classList.add('drag-over');
});

boardEl.addEventListener('dragleave', (e) => {
  const col = e.target.closest('.col');
  if (col && !col.contains(e.relatedTarget)) col.classList.remove('drag-over');
});

boardEl.addEventListener('drop', async (e) => {
  const col = e.target.closest('.col');
  if (!col) return;
  e.preventDefault();
  col.classList.remove('drag-over');
  const id = e.dataTransfer.getData('text/plain');
  if (!id) return;
  try {
    await QA.moveCard(id, col.dataset.col);
    load();
  } catch (err) {
    statusEl.textContent = 'Could not move: ' + err.message;
  }
});

addBtn.addEventListener('click', async () => {
  const title = newTitle.value.trim();
  if (!title) return;
  addBtn.disabled = true;
  try {
    await QA.createCard({ title: title, column: 'doing' });
    newTitle.value = '';
    load();
  } catch (err) {
    statusEl.textContent = 'Could not add: ' + err.message;
  } finally {
    addBtn.disabled = false;
  }
});
newTitle.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBtn.click(); });

async function load() {
  if (dragging) return;
  try {
    const cards = await QA.fetchCards();
    warnEl.hidden = true;
    statusEl.textContent = cards.length + ' card' + (cards.length === 1 ? '' : 's');
    render(cards);
  } catch (err) {
    warnEl.hidden = false;
    statusEl.textContent = '';
    boardEl.innerHTML = '';
  }
}

/* the passive/periodic refresh skips while a reply is open, so a poll never
   wipes text someone's mid-typing; an explicit action (move/delete/drop/send)
   on any card still refreshes immediately via its own load() call above */
function passiveRefresh() {
  if (document.visibilityState === 'visible' && !replyingId) load();
}

load();
setInterval(passiveRefresh, 12000);
document.addEventListener('visibilitychange', passiveRefresh);
