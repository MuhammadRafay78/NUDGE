/* Just three — "needs a decision, a reply, or is blocked on someone else"
   used to be its own column here too, but that's exactly what the Action
   Items board is for now, so a same-named column on every board was just
   the same grouping done twice. Action Items gets a fourth column of its
   own, though: "blocked on someone else's reply" is a distinct state from
   "not started" (Inbox) or "actively being worked" (Doing), and common
   enough on that board specifically — its whole reason for existing is
   client asks waiting on something — to earn its own column rather than
   living inside Doing. Same lists as the extension's common.js, duplicated
   for the same reason as ME below. */
const COLUMNS = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'doing', label: 'Doing' },
  { id: 'done', label: 'Done' }
];
const ACTION_ITEMS_COLUMNS = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'doing', label: 'Doing' },
  { id: 'waiting', label: 'Waiting for info' },
  { id: 'done', label: 'Done' }
];
function columnsForBoard(boardId) {
  return boardId === 'actionitems' ? ACTION_ITEMS_COLUMNS : COLUMNS;
}

/* Boards sharing the same three columns above — Main for one-off client
   asks, QTM for quarterly-tax-meeting prep/follow-up (including its own
   data upkeep), Tax Plan Draft for anything mentioning a discovery call
   prep note, Action Items for anything that itself reads as an action-/
   pending-items list regardless of which client or meeting it's for. A
   freshly-tagged card picks one automatically (see the extension's
   classifyCardBoard/keywordBoardOverride/checkSlack); this is just which
   one is on screen right now. */
const BOARDS = [
  { id: 'main', label: 'Main' },
  { id: 'qtm', label: 'QTM' },
  { id: 'taxplan', label: 'Tax Plan Draft' },
  { id: 'actionitems', label: 'Action Items' }
];
/* A card with no .board (filed before boards existed) or one that names a
   board that's since been retired (e.g. the old "masterdata", or "slack" —
   Slack-sourced cards go through normal routing now) falls back to Main
   instead of vanishing from every tab. */
function cardBoard(c) {
  return (c.board && BOARDS.some((b) => b.id === c.board)) ? c.board : 'main';
}

/* A card whose column doesn't exist on its own board — the old 'action'
   column (from before Action Items became its own board and that column
   was retired), or 'waiting' on a card since moved off Action Items,
   which is the only board with that column — falls back to Doing, "still
   active", same spirit as cardBoard's fallback above. */
function cardColumn(c) {
  const cols = columnsForBoard(cardBoard(c));
  return (c.column && cols.some((col) => col.id === c.column)) ? c.column : 'doing';
}

/* Same list as ME in the extension's common.js — duplicated rather than
   shared, since this page is a standalone webpage with no access to the
   extension's code at all, same reason cardBoard() above is duplicated
   too. Used to flag a comment in the thread that mentions him, same as
   the extension's board does. */
const ME = ['@rafay10', '@rafay', 'Rafay', 'taxplan@dilucci.com'];

/* Whole calendar days in this phone's own local time — good enough for a
   personal device, and simpler than the extension's business-timezone
   version since there's only one reader to get right here. */
function dueLabel(due, dueComplete) {
  if (!due) return null;
  const then = new Date(due);
  if (isNaN(then.getTime())) return null;
  const dayStart = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const days = Math.round((dayStart(then) - dayStart(new Date())) / 864e5);
  const date = then.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  if (dueComplete) return { text: 'Due ' + date, done: true };
  if (days < 0) { const n = Math.abs(days); return { text: n === 1 ? 'Due yesterday' : n + ' days overdue' }; }
  if (days === 0) return { text: 'Due today' };
  if (days === 1) return { text: 'Due tomorrow' };
  return { text: 'Due ' + date };
}

/* "3 days overdue" baked into text at filing time freezes there forever —
   recompute it from the raw due date on every render instead (the board
   already reloads on an interval and on focus, so this alone keeps it
   current with no separate polling). A card from before dueAt existed
   falls back to whatever static text it already has. */
function dueText(card) {
  if (card.dueAt) {
    const lab = dueLabel(card.dueAt, card.dueComplete);
    if (lab) return lab.text;
  }
  return card.due || '';
}

/* Soonest due (including overdue, which sorts earliest of all) first, a
   card with no dueAt last — Array#sort is stable, so cards that tie (all
   undated, most often) keep whatever order they already had rather than
   getting shuffled. Only dueAt is trusted here, same as dueText() above. */
function dueSortValue(card) {
  return card.dueAt ? new Date(card.dueAt).getTime() : Infinity;
}

/* A phone gets its code from the full install/pairing flow in app.js — a
   laptop or any other browser just needs a link with the code already in
   it (see "Copy board link" in the extension's Settings), so this page
   accepts ?code= directly rather than requiring that flow at all. Saved to
   localStorage too, so the plain /board.html link keeps working here
   afterward without the query string. */
const urlCode = new URLSearchParams(location.search).get('code');
if (urlCode && urlCode.trim()) localStorage.setItem('nudgeCode', urlCode.trim().toUpperCase());
const code = (urlCode && urlCode.trim().toUpperCase()) || localStorage.getItem('nudgeCode');
const boardEl = document.getElementById('board');
const boardTabsEl = document.getElementById('boardTabs');
const statusEl = document.getElementById('status');
const cardSearch = document.getElementById('cardSearch');
const sortModeEl = document.getElementById('sortMode');
const modalEl = document.getElementById('cardModal');
const modalBoxEl = document.getElementById('cardModalBox');

let activeBoard = localStorage.getItem('nudgeActiveBoard') || 'main';
if (!BOARDS.some((b) => b.id === activeBoard)) activeBoard = 'main';

const SORT_MODES = ['due', 'added'];
let sortMode = localStorage.getItem('nudgeSortMode') || 'due';
if (!SORT_MODES.includes(sortMode)) sortMode = 'due';
sortModeEl.value = sortMode;
sortModeEl.addEventListener('change', () => {
  sortMode = SORT_MODES.includes(sortModeEl.value) ? sortModeEl.value : 'due';
  localStorage.setItem('nudgeSortMode', sortMode);
  render(lastCards);
});

/* "Date added" is newest first — cards already came back from the API in
   that order (both backends unshift a new one onto the list), this just
   keeps it true regardless of what "due date" mode leaves the array in
   after a switch back. */
function sortCards(items) {
  return sortMode === 'added'
    ? items.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    : items.slice().sort((a, b) => dueSortValue(a) - dueSortValue(b));
}

function ago(ms) {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return s + 's ago';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.round(h / 24) + 'd ago';
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
  return data;
}

async function fetchCards() {
  const data = await api('/api/cards?code=' + encodeURIComponent(code));
  return data.cards || [];
}

async function moveCard(id, column) {
  await api('/api/cards/' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code, column: column })
  });
}

async function moveCardBoard(id, board) {
  await api('/api/cards/' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code, board: board })
  });
}

async function deleteCard(id) {
  await api('/api/cards/' + encodeURIComponent(id), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code })
  });
}

/* Read-only mirror of what the extension's "Open card" modal shows — the
   server proxies Trello with its own key+token (Settings on the server,
   not here) since this page has no Trello session of its own. Not every
   deployment has that configured, so a 501 here is expected and handled,
   not an error to alarm over. */
async function fetchTrelloCard(cardId) {
  const data = await api('/api/trello-card?cardId=' + encodeURIComponent(cardId));
  return { comments: data.comments || [] };
}

function itemHtml(card) {
  const openLink = card.url ? '<a class="open" href="' + esc(card.url) + '" target="_blank" rel="noreferrer">Trello &#8599;</a>' : '';
  const options = columnsForBoard(cardBoard(card)).map((c) =>
    '<option value="' + c.id + '"' + (c.id === cardColumn(card) ? ' selected' : '') + '>' + c.label + '</option>'
  ).join('');
  const boardOptions = BOARDS.map((b) =>
    '<option value="' + b.id + '"' + (b.id === cardBoard(card) ? ' selected' : '') + '>' + b.label + '</option>'
  ).join('');
  const body = card.body || '';
  /* Lead with the client/card name — that's what matters at a glance. The
     generic "X tagged you" line becomes a small byline underneath (or, for a
     hand-typed card with no client name yet, it's all there is). */
  const heading = card.context || card.title;
  const byline = card.context ? card.title : '';
  const due = dueText(card);
  return (
    '<div class="item" data-id="' + esc(card.id) + '" draggable="true">' +
      '<div class="t">' + esc(heading) + '</div>' +
      (byline ? '<div class="sub">' + esc(byline) + '</div>' : '') +
      (due ? '<div class="due">' + esc(due) + '</div>' : '') +
      (body ? '<div class="b">' + esc(body) + '</div>' : '') +
      /* Two selects plus the timestamp/Trello-link/delete button couldn't
         fit on one row on a phone-width tile without crushing "when" down
         to a sliver of wrapped characters — give the selects their own
         row instead. */
      '<div class="moves">' +
        '<select class="move-board" title="Board…">' + boardOptions + '</select>' +
        '<select class="move">' + options + '</select>' +
      '</div>' +
      '<div class="meta">' +
        /* When this was actually tagged/filed — not when it was last
           touched. The server bumps updatedAt on any PATCH at all,
           including a plain column/board move, so this badge picking up
           that field instead made a 17-day-overdue card read as "1m ago"
           the moment it got dragged or bulk-recategorized — nothing
           actually happened to the card itself. */
        '<span class="when">' + ago(card.createdAt) + '</span>' +
        openLink +
        '<button class="del" title="Delete">&times;</button>' +
      '</div>' +
    '</div>'
  );
}

/* ---------- "Open card" ----------
   A tile only ever showed a 3-line preview with no way to see the rest —
   tapping it now opens the full card. Same dense-note formatting as the
   extension's board: a bold line ending in ":" is a section header, any
   other bold-only line or a " - " item is a bullet under it, a run-on
   paragraph splits onto separate lines per sentence, and a "_..._" span
   loses its literal underscores rather than showing them raw. Nothing
   here can post back to Trello, or read anything beyond the one snippet
   already stored on this card — this page has no Trello session (it
   isn't the extension, so it can't read trello.com's cookies or make an
   authenticated request to it) — so the way to see or do anything else
   with this card is the "Trello ↗" link, which opens the real thing in
   whatever browser you're actually logged into Trello with. */

function formatBodyHtml(text) {
  if (!text) return '<div class="empty">Nothing else on this card.</div>';
  let t = esc(text);
  /* A missing space after a sentence-ending period ("...on Canopy.We also
     have...") is a common hand-typing slip and otherwise blocks the
     sentence-split below from ever seeing a boundary there. Skipped right
     after a single capital letter so a tight abbreviation like "U.S."
     isn't pried open into "U. S." */
  t = t.replace(/(?<!\b[A-Z])\.(?=[A-Z])/g, '. ');
  /* Trello's own comment box treats an underscore-wrapped word or phrase
     as italic, but recovering that pairing reliably falls apart once a
     sentence inside the span gets split onto its own line below — so
     this just drops the delimiter-shaped underscore rather than showing
     it as literal clutter. A mid-word underscore like "@some_user" is
     left alone. */
  t = t.replace(/(?<!\w)_|_(?!\w)/g, '');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  t = t.replace(/(.)(<b>)/g, '$1\n$2');
  t = t.replace(/ - (?=\S)/g, '\n- ');
  /* Plain prose with no markdown at all still reads as one wall of text if
     several sentences are run together with no paragraph breaks — split
     those onto their own line too. Skipped right after a title or
     initial ("Mr.", "U.S.") so "Reach out to Mr. Smith" doesn't get cut
     in half. */
  t = t.replace(/(?<!\b(?:Mr|Mrs|Ms|Dr|Jr|Sr|vs|etc|e\.g|i\.e|[A-Z]))([.!?])\s+(?=[A-Z<])/g, '$1\n');
  const lines = t.split('\n').map((line) => line.trim().replace(/\s*-\s*$/, '')).filter(Boolean);
  if (!lines.length) return '<div class="empty">Nothing else on this card.</div>';

  return lines.map((line) => {
    const bareBold = line.match(/^<b>([^<]*)<\/b>$/);
    if (bareBold) {
      return /:\s*$/.test(bareBold[1]) ? '<div class="h">' + line + '</div>' : '<div class="li">' + line + '</div>';
    }
    if (line.indexOf('- ') === 0) return '<div class="li">' + line.slice(2) + '</div>';
    return '<div class="p">' + line + '</div>';
  }).join('');
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* A card's own NOTE is already known to mention him (that's the whole
   reason it was filed) — but once the full thread is showing, later
   replies from other people are exactly where a "can you also do X" or
   an actual action item tends to hide. Marking the whole comment bubble
   for that read as a wall of orange with no indication of what actually
   triggered it, so this instead wraps just the matched handle/name itself
   — safe to run on already-built HTML here since the only markup this
   text ever carries is <div>/<b> around escaped plain text, nothing with
   an attribute value that could accidentally match. Names are tried
   longest-first so "@rafay10" wins over the "@rafay" it starts with,
   rather than only the prefix getting marked. */
function highlightMentions(html) {
  const toks = ME.slice().sort((a, b) => b.length - a.length);
  const re = new RegExp('(' + toks.map(escapeRe).join('|') + ')', 'gi');
  return html.replace(re, '<mark class="mention-hit">$1</mark>');
}

function modalCommentHtml(c) {
  const when = c.at ? ago(c.at) : '';
  const who = c.byName || c.by || 'Someone';
  return (
    '<div class="modal-item">' +
      '<div class="meta2"><b>' + esc(who) + '</b>' + (when ? ' &middot; ' + esc(when) : '') + '</div>' +
      '<div class="hist-text">' + highlightMentions(formatBodyHtml(c.text)) + '</div>' +
    '</div>'
  );
}

function modalHtml(card) {
  const heading = card.context || card.title;
  const byline = card.context ? card.title : '';
  const due = dueText(card);
  const trelloLink = card.url
    ? '<a class="open" href="' + esc(card.url) + '" target="_blank" rel="noreferrer">Reply on Trello &#8599;</a>'
    : '';

  let body;
  if (!card.cardId) {
    /* A hand-typed or Slack-origin card has no Trello card behind it at
       all — nothing to fetch, so this is the only content there ever is. */
    body = formatBodyHtml(card.body);
  } else {
    const cache = historyCache[card.id];
    if (!cache || cache.loading) {
      body = '<div class="status" style="padding:0">Loading the full card from Trello…</div>';
    } else if (!cache.ok) {
      body = '<div class="status" style="padding:0;color:var(--accent)">' + esc(cache.error) + '</div>' + formatBodyHtml(card.body);
    } else {
      const comments = cache.comments || [];
      body = comments.length ? comments.map(modalCommentHtml).join('') : formatBodyHtml(card.body);
    }
  }

  return (
    '<div class="modal-head">' +
      '<button class="modal-close" title="Close">&times;</button>' +
      '<div class="t">' + esc(heading) + '</div>' +
      (byline ? '<div class="sub">' + esc(byline) + '</div>' : '') +
      (due ? '<div class="due">' + esc(due) + '</div>' : '') +
      trelloLink +
    '</div>' +
    '<div class="modal-body">' + body + '</div>'
  );
}

let modalCardId = null;
let cardsById = {};
let lastCards = [];    // re-filtered on every search keystroke, no refetch needed
let searchQuery = '';
const historyCache = {};   // card id -> { loading } | { ok:true, comments } | { ok:false, error }

/* This page has no Trello session of its own, but a card the extension has
   already opened once carries its own comment thread already — the
   extension pushed it here the moment it fetched one for its own "Open
   card" panel (see loadHistory in the extension's board.js), so most of
   the time there's nothing to fetch at all. That only ever happens for a
   card someone opened in the extension first, though, so this still tries
   a live Trello fetch too — via the server's own TRELLO_API_KEY/TOKEN, if
   one's configured — as a background refresh, never replacing an
   already-synced thread with an error if that refresh comes up empty. */
function openModal(id) {
  const card = cardsById[id];
  if (!card) return;
  modalCardId = id;
  const synced = Array.isArray(card.comments);
  if (synced) {
    historyCache[id] = { ok: true, comments: card.comments.slice().sort((a, b) => (b.at || 0) - (a.at || 0)) };
  } else if (card.cardId) {
    delete historyCache[id];   // always fetch fresh on open, so a card just updated in Trello shows that
    historyCache[id] = { loading: true };
  }
  modalBoxEl.innerHTML = modalHtml(card);
  modalEl.hidden = false;
  if (card.cardId) loadHistory(id, synced);
}

async function loadHistory(id, silent) {
  const card = cardsById[id];
  if (!card || !card.cardId) return;
  try {
    const res = await fetchTrelloCard(card.cardId);
    historyCache[id] = { ok: true, comments: res.comments.slice().sort((a, b) => (b.at || 0) - (a.at || 0)) };
  } catch (e) {
    /* Already showing the extension-synced thread — a failed background
       refresh (most often: this server has no TRELLO_API_KEY/TOKEN set up)
       is expected, not a reason to blank that out with an error. */
    if (silent && historyCache[id] && historyCache[id].ok) return;
    historyCache[id] = { ok: false, error: (e && e.message) || 'Could not reach the board server.' };
  }
  if (modalCardId === id) modalBoxEl.innerHTML = modalHtml(card);
}

function closeModal() {
  modalCardId = null;
  modalEl.hidden = true;
  modalBoxEl.innerHTML = '';
}

modalEl.addEventListener('click', (e) => {
  if (e.target === modalEl || e.target.classList.contains('modal-close')) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalCardId) closeModal();
});

/* Every word typed must show up somewhere on the card, same as the
   extension's board — "qtm3 dwight" finds a card whose client is QTM3
   and whose body mentions Dwight, even if those words are far apart. */
function searchTerms(q) {
  return q.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function matchesSearch(card, terms) {
  if (!terms.length) return true;
  const hay = [card.context, card.title, card.body, card.due, card.actorUser].filter(Boolean).join(' ').toLowerCase();
  return terms.every((t) => hay.indexOf(t) > -1);
}

function renderBoardTabs(cards) {
  boardTabsEl.innerHTML = BOARDS.map((b) => {
    const n = cards.filter((c) => cardBoard(c) === b.id).length;
    return '<button class="board-tab' + (b.id === activeBoard ? ' on' : '') + '" data-board="' + b.id + '">' +
      esc(b.label) + ' <span class="n">' + n + '</span></button>';
  }).join('');
}

boardTabsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.board-tab');
  if (!btn || btn.dataset.board === activeBoard) return;
  activeBoard = btn.dataset.board;
  localStorage.setItem('nudgeActiveBoard', activeBoard);
  render(lastCards);
});

function render(cards) {
  lastCards = cards;
  cardsById = {};
  cards.forEach((c) => { cardsById[c.id] = c; });
  if (modalCardId && !cardsById[modalCardId]) closeModal();   // card moved/deleted elsewhere

  renderBoardTabs(cards);
  const onBoard = cards.filter((c) => cardBoard(c) === activeBoard);

  const terms = searchTerms(searchQuery);
  const visible = terms.length ? onBoard.filter((c) => matchesSearch(c, terms)) : onBoard;

  boardEl.innerHTML = columnsForBoard(activeBoard).map((col) => {
    const total = onBoard.filter((c) => cardColumn(c) === col.id);
    const items = sortCards(visible.filter((c) => cardColumn(c) === col.id));
    return (
      '<div class="col" data-col="' + col.id + '">' +
        '<h2>' + col.label + ' <span class="n">' + (terms.length ? items.length + ' / ' + total.length : total.length) + '</span></h2>' +
        (items.length ? items.map(itemHtml).join('')
          : '<div class="empty">' + (terms.length ? 'No matches here.' : 'Nothing here.') + '</div>') +
      '</div>'
    );
  }).join('');

  if (modalCardId) modalBoxEl.innerHTML = modalHtml(cardsById[modalCardId]);   // keep it in sync while open
}

boardEl.addEventListener('change', async (e) => {
  if (e.target.classList.contains('move')) {
    const id = e.target.closest('.item').dataset.id;
    try {
      await moveCard(id, e.target.value);
      load();
    } catch (err) {
      statusEl.textContent = 'Could not move: ' + err.message;
    }
    return;
  }
  if (e.target.classList.contains('move-board')) {
    const id = e.target.closest('.item').dataset.id;
    try {
      await moveCardBoard(id, e.target.value);
      load();
    } catch (err) {
      statusEl.textContent = 'Could not move: ' + err.message;
    }
  }
});

boardEl.addEventListener('click', async (e) => {
  if (e.target.classList.contains('del')) {
    const id = e.target.closest('.item').dataset.id;
    try {
      await deleteCard(id);
      load();
    } catch (err) {
      statusEl.textContent = 'Could not delete: ' + err.message;
    }
    return;
  }
  /* tapping anywhere else on the tile opens it — same as the extension's
     board — except the controls that already do their own thing */
  if (e.target.closest('select, a.open')) return;
  const item = e.target.closest('.item');
  if (item) openModal(item.dataset.id);
});

/* ---------- drag and drop — between columns, and onto a board tab to move
   a card to a different board entirely, same as the extension's board ---------- */

boardEl.addEventListener('dragstart', (e) => {
  const item = e.target.closest('.item');
  if (!item) return;
  e.dataTransfer.setData('text/plain', item.dataset.id);
  e.dataTransfer.effectAllowed = 'move';
  item.classList.add('dragging');
});

boardEl.addEventListener('dragend', (e) => {
  const item = e.target.closest('.item');
  if (item) item.classList.remove('dragging');
  boardEl.querySelectorAll('.col.drag-over').forEach((c) => c.classList.remove('drag-over'));
  boardTabsEl.querySelectorAll('.board-tab.drag-over').forEach((b) => b.classList.remove('drag-over'));
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
    await moveCard(id, col.dataset.col);
    load();
  } catch (err) {
    statusEl.textContent = 'Could not move: ' + err.message;
  }
});

boardTabsEl.addEventListener('dragover', (e) => {
  const tab = e.target.closest('.board-tab');
  if (!tab) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  tab.classList.add('drag-over');
});

boardTabsEl.addEventListener('dragleave', (e) => {
  const tab = e.target.closest('.board-tab');
  if (tab && !tab.contains(e.relatedTarget)) tab.classList.remove('drag-over');
});

boardTabsEl.addEventListener('drop', async (e) => {
  const tab = e.target.closest('.board-tab');
  if (!tab) return;
  e.preventDefault();
  tab.classList.remove('drag-over');
  const id = e.dataTransfer.getData('text/plain');
  if (!id) return;
  try {
    await moveCardBoard(id, tab.dataset.board);
    load();
  } catch (err) {
    statusEl.textContent = 'Could not move: ' + err.message;
  }
});

cardSearch.addEventListener('input', () => {
  searchQuery = cardSearch.value;
  render(lastCards);
});

async function load() {
  try {
    const cards = await fetchCards();
    statusEl.textContent = '';
    render(cards);
  } catch (err) {
    statusEl.textContent = 'Could not load the board: ' + err.message;
  }
}

if (!code) {
  statusEl.textContent = 'Pair this phone first from the home page, then come back here.';
} else {
  load();
  setInterval(() => { if (document.visibilityState === 'visible') load(); }, 12000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });
}
