/* Kanban board — same server + pairing code as the phone relay (Settings > Mobile notifications). */

const boardEl = document.getElementById('board');
const boardTabsEl = document.getElementById('boardTabs');
const statusEl = document.getElementById('status');
const warnEl = document.getElementById('notConfigured');
const cardSearch = document.getElementById('cardSearch');
const cardSearchClear = document.getElementById('cardSearchClear');
const backfillBtn = document.getElementById('backfillBtn');
const modalEl = document.getElementById('cardModal');
const modalBoxEl = document.getElementById('cardModalBox');
const dailyUpdateBtn = document.getElementById('dailyUpdateBtn');
const updatePanel = document.getElementById('updatePanel');
const updateText = document.getElementById('updateText');
const updateWhen = document.getElementById('updateWhen');
const updateStatus = document.getElementById('updateStatus');
const updateRecipient = document.getElementById('updateRecipient');
const updateRegen = document.getElementById('updateRegen');
const updateCopy = document.getElementById('updateCopy');
const updateClose = document.getElementById('updateClose');
const updateAuto = document.getElementById('updateAuto');
const updateAutoTime = document.getElementById('updateAutoTime');

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* Escapes first, then wraps whichever search terms actually appear —
   so a match is visible right on the card instead of you having to
   re-read the whole tile to work out why it showed up. */
function hi(s, terms) {
  const safe = esc(s);
  if (!terms || !terms.length) return safe;
  const pattern = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).filter(Boolean).join('|');
  if (!pattern) return safe;
  return safe.replace(new RegExp('(' + pattern + ')', 'ig'), '<mark>$1</mark>');
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
let cardsById = {};            // last-rendered cards
let lastCards = [];            // same, as a plain list — re-filtered on every search keystroke
let searchQuery = '';          // live text of the search box, survives a refresh
const peopleCache = {};        // cardId -> [{username, fullName}], fetched once per open
let modalCardId = null;          // which card's "Open card" modal is showing, or null
const historyCache = {};         // card id -> { loading } | { ok:true, comments } | { ok:false, error }
const replyDefaultUser = {};     // card id -> username to @mention, when replying to a specific comment
                                  // instead of the card's original tagger
let replyDraft = null;           // live text of the modal's reply box — the modal is a separate DOM
                                  // tree from the board, so a board refresh never touches it, but the
                                  // modal's own comment-list reload does rebuild it, hence tracking this
let attachedImage = null;        // { file, previewUrl } picked for the modal's reply box, or null

/* Main vs QTM vs Tax Plan Draft — three boards sharing the same four
   columns. A card with no .board (filed before boards existed) or one
   that names a board that's since been retired (e.g. the old
   "masterdata") falls back to Main instead of vanishing from every tab. */
function cardBoard(c) {
  return (c.board && QA.BOARDS.some((b) => b.id === c.board)) ? c.board : 'main';
}
let activeBoard = localStorage.getItem('nudgeActiveBoard') || 'main';
if (!QA.BOARDS.some((b) => b.id === activeBoard)) activeBoard = 'main';

function renderBoardTabs(cards) {
  boardTabsEl.innerHTML = QA.BOARDS.map((b) => {
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

function clearAttachedImage() {
  if (attachedImage) URL.revokeObjectURL(attachedImage.previewUrl);
  attachedImage = null;
}

function setAttachedImage(file) {
  clearAttachedImage();
  attachedImage = { file: file, previewUrl: URL.createObjectURL(file) };
  paintImagePreview();
}

function paintImagePreview() {
  const box = modalBoxEl.querySelector('.img-preview');
  if (!box) return;
  if (!attachedImage) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML =
    '<img src="' + attachedImage.previewUrl + '" alt="">' +
    '<span class="img-preview-name">' + esc(attachedImage.file.name) + '</span>' +
    '<button class="img-preview-x" title="Remove image">&times;</button>';
}

/* A comment sent with an image ends with "![name](url)" — pulled back out
   here so it renders as an actual picture instead of literal markdown, and
   the readable text above it still runs through the normal tidy/escape
   path untouched. */
function extractImageMarkdown(text) {
  const s = String(text == null ? '' : text);
  const m = s.match(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)\s*$/);
  if (!m) return { rest: s, image: null };
  return { rest: s.slice(0, m.index).trim(), image: { alt: m[1] || 'image', url: m[2] } };
}

function defaultReplyUser(card) {
  return replyDefaultUser[card.id] || card.actorUser || '';
}

/* A dense Trello note — often "**Header:** - item - item **Header:** - item"
   run together with no real line breaks — read fine in Trello's own comment
   box (which wraps around the markup as you type) but turns into one
   unreadable wall of text once it is just plain-escaped here. This makes
   "**bold**" real bold, splits it onto separate lines by section, and then
   tells the three shapes that turn up apart so each gets its own look:
   a bold line ending in ":" is a section header (its own color, spaced
   above); any other bold-only line or a " - " item is a bullet under it;
   everything else stays a plain line. Ordinary text with no markdown in it
   — "Got it, thanks", "@nestor thanks" — passes through as a single plain
   line, unchanged. */
function formatCommentHtml(text) {
  let t = esc(QA.tidyCommentText(text));
  t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  t = t.replace(/(.)(<b>)/g, '$1\n$2');
  t = t.replace(/ - (?=\S)/g, '\n- ');
  const lines = t.split('\n').map((line) => line.trim().replace(/\s*-\s*$/, '')).filter(Boolean);

  return lines.map((line) => {
    const bareBold = line.match(/^<b>([^<]*)<\/b>$/);
    if (bareBold) {
      return /:\s*$/.test(bareBold[1])
        ? '<div class="hist-h">' + line + '</div>'
        : '<div class="hist-li">' + line + '</div>';
    }
    if (line.indexOf('- ') === 0) return '<div class="hist-li">' + line.slice(2) + '</div>';
    return '<div class="hist-p">' + line + '</div>';
  }).join('');
}

function itemHtml(card, terms) {
  /* A separate, clearly-labelled escape hatch to the real Trello page — kept
     small and secondary, since "Open card" opens the comment thread right
     here instead of sending you to trello.com. */
  const trelloLink = card.url
    ? '<a class="open" href="' + esc(card.url) + '" target="_blank" rel="noreferrer" title="Open the real card on trello.com">Trello &#8599;</a>'
    : '';
  const body = card.body || '';
  const long = body.length > LONG_BODY;
  const isOpen = expanded.has(card.id);
  const canReply = !!card.cardId;
  /* The client/card name is what matters at a glance — lead with it. The
     generic "X tagged you" line is demoted to a byline underneath (or, for a
     hand-typed card with no client name yet, it's all there is, so it stays
     the heading). */
  const heading = card.context || card.title;
  const byline = card.context ? card.title : '';
  const moveOptions = QA.BOARD_COLUMNS.map((c) =>
    '<option value="' + c.id + '"' + (c.id === card.column ? ' selected' : '') + '>' + c.label + '</option>'
  ).join('');
  const boardOptions = QA.BOARDS.map((b) =>
    '<option value="' + b.id + '"' + (b.id === cardBoard(card) ? ' selected' : '') + '>' + b.label + '</option>'
  ).join('');
  return (
    /* Dragging still works, but it needs a steady hand and a column that's
       actually on screen — this dropdown moves a card in one click/tap
       regardless. The handle is just a visual cue for dragging; grabbing
       anywhere else on the card that isn't itself a button/link/select
       works exactly the same. Clicking anywhere on the card that isn't a
       control opens it — same as clicking "Open card" — see the boardEl
       click handler below. */
    '<div class="item" data-id="' + esc(card.id) + '" draggable="true">' +
      '<span class="handle" title="Drag to move between columns" aria-hidden="true">&#8942;&#8942;</span>' +
      '<div class="t" title="' + esc(heading) + '">' + hi(heading, terms) + '</div>' +
      (byline ? '<div class="sub">' + hi(byline, terms) + '</div>' : '') +
      (card.due ? '<div class="due">' + hi(card.due, terms) + '</div>' : '') +
      (body ? '<div class="b' + (isOpen ? '' : ' clamp') + '">' + hi(body, terms) + '</div>' : '') +
      (long ? '<button class="more">' + (isOpen ? 'Show less' : 'Show more') + '</button>' : '') +
      /* Action pills get their own row so they can wrap on a narrow card
         without ever pulling "when"/delete along with them — those two stay
         paired on a fixed, always-two-item row underneath, so delete never
         ends up stranded alone on its own line. */
      (canReply || trelloLink ? (
        '<div class="acts">' +
          (canReply ? '<button class="hist-btn">Open card</button>' : '') +
          (canReply ? '<button class="reply-btn">Reply</button>' : '') +
          trelloLink +
        '</div>'
      ) : '') +
      /* Two selects plus a timestamp and delete button couldn't fit on one
         row without squeezing "when" down to a vertical sliver of wrapped
         characters — give the selects their own row instead. */
      '<div class="moves">' +
        '<select class="move-board" title="Board…">' + boardOptions + '</select>' +
        '<select class="move" title="Move to…">' + moveOptions + '</select>' +
      '</div>' +
      '<div class="row2">' +
        '<span class="when">' + QA.ago(card.updatedAt || card.createdAt) + '</span>' +
        '<button class="del" title="Delete">&times;</button>' +
      '</div>' +
    '</div>'
  );
}

/* ---------- "Open card" modal: just the comments, nothing else ----------
   Trello's own card-open behavior — click a card, it opens on top of the
   board, you read the thread and reply, close it, you're right back where
   you were. No description, no checklist summary; those turned out to be
   clutter nobody asked for. Only one modal exists at a time (there's only
   ever one open card), which is also what lets the reply composer be a
   single persistent piece of markup instead of one per card. */

function modalCommentHtml(c, i) {
  const when = c.at ? QA.ago(c.at) : '';
  const who = c.byName || c.by || 'Someone';
  const reactBtns = QA.REACTIONS.map((r) =>
    '<button class="emo hist-emo" data-emoji="' + esc(r.emoji) + '" title="' + esc(r.label) + '">' + r.emoji + '</button>'
  ).join('');
  const { rest, image } = extractImageMarkdown(c.text);
  const textHtml = rest ? '<div class="hist-text">' + formatCommentHtml(rest) + '</div>' : '';
  const imgHtml = image
    ? '<a href="' + esc(image.url) + '" target="_blank" rel="noreferrer">' +
      '<img class="hist-img" src="' + esc(image.url) + '" alt="' + esc(image.alt) + '" loading="lazy"></a>'
    : '';
  return (
    '<div class="modal-item" data-idx="' + i + '">' +
      '<div class="hist-meta"><b>' + esc(who) + '</b>' + (when ? ' &middot; ' + esc(when) : '') + '</div>' +
      textHtml + imgHtml +
      '<div class="hist-acts">' +
        '<button class="react-toggle" title="React">&#128578;+</button>' +
        '<div class="react-row" hidden>' + reactBtns + '</div>' +
        '<button class="hist-reply-btn">Reply</button>' +
        '<span class="rnote"></span>' +
      '</div>' +
    '</div>'
  );
}

function composerHtml(card) {
  const quick = QA.QUICK_REPLIES.map((q) =>
    '<button class="chip" data-q="' + esc(q) + '">' + esc(q) + '</button>'
  ).join('');
  const defaultUser = defaultReplyUser(card);
  const defaultText = replyDraft !== null ? replyDraft : (defaultUser ? '@' + defaultUser + ' ' : '');
  return (
    '<div class="quick">' + quick + '</div>' +
    '<div class="reply-wrap">' +
      '<textarea class="reply-in" rows="2" placeholder="Reply… type @ to tag someone, or drop an image">' + esc(defaultText) + '</textarea>' +
      '<div class="mention-list" hidden></div>' +
    '</div>' +
    '<div class="img-preview" hidden></div>' +
    '<div class="reply-acts">' +
      '<button class="btn go send-reply">Send reply</button>' +
      '<button class="btn attach-btn" title="Attach an image">&#128206; Image</button>' +
      '<input type="file" class="attach-input" accept="image/*" hidden>' +
      '<span class="reply-status"></span>' +
    '</div>'
  );
}

function modalHtml(card) {
  const heading = card.context || card.title;
  const byline = card.context ? card.title : '';
  const trelloLink = card.url
    ? '<a class="open" href="' + esc(card.url) + '" target="_blank" rel="noreferrer">Trello &#8599;</a>'
    : '';
  const cache = historyCache[card.id];

  let body;
  if (!cache || cache.loading) {
    body = '<div class="modal-status">Loading…</div>';
  } else if (!cache.ok) {
    body = '<div class="modal-status bad">&#9888; ' + esc(cache.error || 'Could not load this card.') + '</div>';
  } else {
    const comments = cache.comments || [];
    body = comments.length
      ? comments.map(modalCommentHtml).join('')
      : '<div class="modal-status">No comments yet on this card.</div>';
  }

  return (
    '<div class="modal-head">' +
      '<button class="modal-close" title="Close">&times;</button>' +
      '<div class="t">' + esc(heading) + '</div>' +
      (byline ? '<div class="sub">' + esc(byline) + '</div>' : '') +
      (card.due ? '<div class="due">' + esc(card.due) + '</div>' : '') +
      trelloLink +
    '</div>' +
    '<div class="modal-body">' + body + '</div>' +
    '<div class="modal-foot">' + composerHtml(card) + '</div>'
  );
}

function renderModal(focusComposer) {
  if (!modalCardId) { modalEl.hidden = true; modalBoxEl.innerHTML = ''; return; }
  const card = cardsById[modalCardId];
  if (!card) { closeModal(); return; }
  modalBoxEl.innerHTML = modalHtml(card);
  modalEl.hidden = false;
  paintImagePreview();
  if (focusComposer) {
    const ta = modalBoxEl.querySelector('.reply-in');
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }
}

function openModal(id, focusComposer) {
  modalCardId = id;
  delete historyCache[id];   // always fetch fresh on open, so a just-sent reply shows up
  historyCache[id] = { loading: true };
  renderModal(focusComposer);   // paints the "Loading…" state and focuses the composer, once
  loadHistory(id, focusComposer);
}

function closeModal() {
  modalCardId = null;
  replyDraft = null;
  clearAttachedImage();
  modalEl.hidden = true;
  modalBoxEl.innerHTML = '';
}

/* focusComposer is threaded through so the final render (once the fetch
   resolves) can re-focus the composer the same way the opening render did —
   renderModal() rebuilds the DOM from scratch each time, which would
   otherwise silently drop focus a few hundred ms after "Reply" was clicked. */
async function loadHistory(id, focusComposer) {
  const card = cardsById[id];
  if (!card || !card.cardId) return;
  const res = await QA.cardWholeFor(card.cardId);
  if (res && res.ok) {
    historyCache[id] = { ok: true, comments: (res.comments || []).slice().sort((a, b) => (b.at || 0) - (a.at || 0)) };
  } else {
    historyCache[id] = {
      ok: false,
      error: (res && res.error) || (res && res.status ? 'Trello said no (' + res.status + ').' : 'Could not reach Trello — check you are logged into Trello in this browser.')
    };
  }
  if (modalCardId === id) renderModal(focusComposer);
}

/* Every word typed must show up somewhere on the card — not one contiguous
   phrase — so "qtm3 dwight" finds a card whose client is QTM3 and whose
   body mentions Dwight, even though those two words never sit next to
   each other in the text. */
function searchTerms(q) {
  return q.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function matchesSearch(card, terms) {
  if (!terms.length) return true;
  const hay = [card.context, card.title, card.body, card.due, card.actorUser].filter(Boolean).join(' ').toLowerCase();
  return terms.every((t) => hay.indexOf(t) > -1);
}

function render(cards) {
  lastCards = cards;
  cardsById = {};
  cards.forEach((c) => { cardsById[c.id] = c; });
  if (modalCardId && !cardsById[modalCardId]) closeModal();   // card deleted elsewhere

  renderBoardTabs(cards);
  const onBoard = cards.filter((c) => cardBoard(c) === activeBoard);

  const terms = searchTerms(searchQuery);
  const visible = terms.length ? onBoard.filter((c) => matchesSearch(c, terms)) : onBoard;
  cardSearchClear.hidden = !searchQuery;

  boardEl.innerHTML = QA.BOARD_COLUMNS.map((col) => {
    const total = onBoard.filter((c) => c.column === col.id);
    const items = visible.filter((c) => c.column === col.id);
    return (
      '<div class="col" data-col="' + col.id + '">' +
        '<h2>' + col.label + ' <span class="n">' + (terms.length ? items.length + ' / ' + total.length : total.length) + '</span></h2>' +
        (items.length ? items.map((c) => itemHtml(c, terms)).join('')
          : '<div class="empty">' + (terms.length ? 'No matches here.' : 'Nothing here.') + '</div>') +
      '</div>'
    );
  }).join('');
}

/* ---------- reply, including @mention autocomplete — all modal-scoped,
   since only one reply composer exists on the page at a time now ---------- */

function closeMentionList() {
  const list = modalBoxEl.querySelector('.mention-list');
  if (list) { list.hidden = true; list.innerHTML = ''; list.dataset.picks = ''; }
}

function drawMentionList(picks, sel) {
  const list = modalBoxEl.querySelector('.mention-list');
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

function insertMention(username) {
  const ta = modalBoxEl.querySelector('.reply-in');
  if (!ta) return;
  const tok = mentionToken(ta);
  const at = tok ? tok.start : (ta.selectionStart || 0);
  const before = ta.value.slice(0, at);
  const after = ta.value.slice(ta.selectionStart || 0);
  ta.value = before + '@' + username + ' ' + after;
  replyDraft = ta.value;
  const pos = (before + '@' + username + ' ').length;
  ta.focus();
  ta.setSelectionRange(pos, pos);
  closeMentionList();
}

async function maybeSuggest(ta, cardId) {
  const tok = mentionToken(ta);
  if (!tok) { closeMentionList(); return; }
  const people = await peopleFor(cardId);
  const picks = QA.matchPeople(people, tok.q);
  drawMentionList(picks, 0);
}

async function sendReply() {
  const card = cardsById[modalCardId];
  const ta = modalBoxEl.querySelector('.reply-in');
  const status = modalBoxEl.querySelector('.reply-status');
  const sendBtn = modalBoxEl.querySelector('.send-reply');
  if (!card || !ta) return;
  const text = (ta.value || '').trim();
  const textIsJustMention = text === '@' + defaultReplyUser(card);
  if ((!text || textIsJustMention) && !attachedImage) { ta.focus(); return; }
  sendBtn.disabled = true;
  status.className = 'reply-status';
  status.textContent = attachedImage ? 'Uploading image…' : 'Sending…';
  /* Text left as-is even when it's just the default "@user " mention — with
     an image attached that mention is still what makes Trello notify them,
     it only gets blocked outright above when there's nothing else to send. */
  const res = await QA.replyToCard(card.cardId, text, attachedImage && attachedImage.file);
  if (res && res.ok) {
    status.textContent = 'Sent';
    replyDraft = null;
    clearAttachedImage();
    delete replyDefaultUser[card.id];
    try { await QA.moveCard(card.id, 'done'); } catch (e) {}
    loadHistory(card.id);   // refresh the thread in place — the modal stays open
    load();
  } else {
    sendBtn.disabled = false;
    status.className = 'reply-status bad';
    status.textContent = QA.replyErrorMessage(res);
  }
}

/* Every comment used to show its whole reaction row all the time — with a
   long thread that was a wall of emoji buttons repeated per reply. Now it's
   one small toggle per comment, and the row only opens on click. */
function toggleReactRow(toggleBtn) {
  const row = toggleBtn.nextElementSibling;
  if (!row || !row.classList.contains('react-row')) return;
  row.hidden = !row.hidden;
}

async function handleModalReactClick(e) {
  const card = cardsById[modalCardId];
  if (!card) return;
  const r = QA.REACTIONS.filter((x) => x.emoji === e.target.dataset.emoji)[0];
  if (!r) return;
  const idx = Number(e.target.closest('.modal-item').dataset.idx);
  const cache = historyCache[modalCardId];
  const c = cache && cache.ok && cache.comments[idx];
  if (!c) return;
  const target = { cardId: card.cardId, text: c.text, actorUser: c.by };
  const scope = e.target.closest('.hist-acts');
  const note = scope.querySelector('.rnote');
  scope.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  note.className = 'rnote';
  note.textContent = 'Reacting…';
  const res = await QA.reactToMention(target, r);
  scope.querySelectorAll('button').forEach((b) => { b.disabled = false; });
  if (!res || !res.ok) {
    note.className = 'rnote bad';
    note.textContent = QA.reactErrorMessage(res);
    return;
  }
  e.target.classList.add('on');
  note.className = 'rnote ok';
  note.textContent = res.already ? r.emoji + ' already there' : r.emoji + ' added';
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

  if (e.target.classList.contains('hist-btn')) {
    openModal(e.target.closest('.item').dataset.id, false);
    return;
  }

  if (e.target.classList.contains('reply-btn')) {
    openModal(e.target.closest('.item').dataset.id, true);
    return;
  }

  if (e.target.classList.contains('del')) {
    const id = e.target.closest('.item').dataset.id;
    try {
      await QA.deleteCard(id);
      load();
    } catch (err) {
      statusEl.textContent = 'Could not delete: ' + err.message;
    }
    return;
  }

  /* Clicking the card itself — its title, context, due chip, body text, the
     drag handle, blank padding — opens it, same as the "Open card" button. */
  if (e.target.closest('select')) return;   // opening/choosing from the move dropdown, not the card
  const item = e.target.closest('.item');
  const card = item && cardsById[item.dataset.id];
  if (!card || !card.cardId) return;
  if (window.getSelection && String(window.getSelection())) return;   // was selecting text, not clicking
  openModal(item.dataset.id, false);
});

boardEl.addEventListener('change', async (e) => {
  if (e.target.classList.contains('move')) {
    const id = e.target.closest('.item').dataset.id;
    try {
      await QA.moveCard(id, e.target.value);
      load();
    } catch (err) {
      statusEl.textContent = 'Could not move: ' + err.message;
    }
    return;
  }
  if (e.target.classList.contains('move-board')) {
    const id = e.target.closest('.item').dataset.id;
    try {
      await QA.updateCard(id, { board: e.target.value });
      load();
    } catch (err) {
      statusEl.textContent = 'Could not move: ' + err.message;
    }
  }
});

/* ---------- the "Open card" modal itself ---------- */

modalEl.addEventListener('click', async (e) => {
  if (e.target === modalEl || e.target.classList.contains('modal-close')) {
    closeModal();
    return;
  }

  if (e.target.classList.contains('react-toggle')) {
    toggleReactRow(e.target);
    return;
  }

  if (e.target.classList.contains('emo')) {
    await handleModalReactClick(e);
    return;
  }

  if (e.target.classList.contains('hist-reply-btn')) {
    const idx = Number(e.target.closest('.modal-item').dataset.idx);
    const cache = historyCache[modalCardId];
    const c = cache && cache.ok && cache.comments[idx];
    replyDefaultUser[modalCardId] = (c && c.by) || '';
    replyDraft = null;
    renderModal(true);
    return;
  }

  if (e.target.classList.contains('send-reply')) {
    await sendReply();
    return;
  }

  if (e.target.classList.contains('chip')) {
    const card = cardsById[modalCardId];
    const ta = modalBoxEl.querySelector('.reply-in');
    const user = defaultReplyUser(card);
    const at = user ? '@' + user + ' ' : '';
    ta.value = at + e.target.dataset.q;
    replyDraft = ta.value;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    closeMentionList();
    return;
  }

  if (e.target.closest('.mention-row')) {
    insertMention(e.target.closest('.mention-row').dataset.u);
    return;
  }

  if (e.target.classList.contains('attach-btn')) {
    const input = modalBoxEl.querySelector('.attach-input');
    if (input) input.click();
    return;
  }

  if (e.target.classList.contains('img-preview-x')) {
    clearAttachedImage();
    paintImagePreview();
    return;
  }
});

modalEl.addEventListener('change', (e) => {
  if (!e.target.classList.contains('attach-input')) return;
  const file = e.target.files && e.target.files[0];
  e.target.value = '';   // so picking the same file twice still fires change
  if (!file) return;
  const status = modalBoxEl.querySelector('.reply-status');
  const err = QA.imageAttachError(file);
  if (err) {
    if (status) { status.className = 'reply-status bad'; status.textContent = err; }
    return;
  }
  if (status) { status.className = 'reply-status'; status.textContent = ''; }
  setAttachedImage(file);
});

modalEl.addEventListener('dragover', (e) => {
  if (!e.target.closest('.reply-wrap')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  e.target.closest('.reply-wrap').classList.add('drag-over');
});

modalEl.addEventListener('dragleave', (e) => {
  const wrap = e.target.closest('.reply-wrap');
  if (wrap) wrap.classList.remove('drag-over');
});

modalEl.addEventListener('drop', (e) => {
  const wrap = e.target.closest('.reply-wrap');
  if (!wrap) return;
  e.preventDefault();
  wrap.classList.remove('drag-over');
  const file = QA.pickImageFromTransfer(e.dataTransfer);
  const status = modalBoxEl.querySelector('.reply-status');
  if (!file) {
    if (status) { status.className = 'reply-status bad'; status.textContent = 'Drop an image file.'; }
    return;
  }
  const err = QA.imageAttachError(file);
  if (err) {
    if (status) { status.className = 'reply-status bad'; status.textContent = err; }
    return;
  }
  if (status) { status.className = 'reply-status'; status.textContent = ''; }
  setAttachedImage(file);
});

modalEl.addEventListener('paste', (e) => {
  if (!e.target.classList.contains('reply-in')) return;
  const file = QA.pickImageFromClipboard(e.clipboardData);
  if (!file) return;   // let a normal text paste through
  e.preventDefault();
  const err = QA.imageAttachError(file);
  const status = modalBoxEl.querySelector('.reply-status');
  if (err) {
    if (status) { status.className = 'reply-status bad'; status.textContent = err; }
    return;
  }
  if (status) { status.className = 'reply-status'; status.textContent = ''; }
  setAttachedImage(file);
});

modalEl.addEventListener('mousedown', (e) => {
  // keep the textarea focused when clicking a mention suggestion
  if (e.target.closest('.mention-row')) e.preventDefault();
});

modalEl.addEventListener('input', (e) => {
  if (!e.target.classList.contains('reply-in')) return;
  replyDraft = e.target.value;
  const card = cardsById[modalCardId];
  maybeSuggest(e.target, card && card.cardId);
});

modalEl.addEventListener('blur', (e) => {
  if (!e.target.classList.contains('reply-in')) return;
  setTimeout(closeMentionList, 120);
}, true);

modalEl.addEventListener('keydown', (e) => {
  if (!e.target.classList.contains('reply-in')) return;
  const list = modalBoxEl.querySelector('.mention-list');
  const picks = list && !list.hidden ? JSON.parse(list.dataset.picks || '[]') : [];
  const sel = list ? Number(list.dataset.sel || 0) : 0;
  const open = picks.length > 0;

  if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    drawMentionList(picks, (sel + (e.key === 'ArrowDown' ? 1 : picks.length - 1)) % picks.length);
    return;
  }
  if (open && (e.key === 'Enter' || e.key === 'Tab')) { e.preventDefault(); insertMention(picks[sel].username); return; }
  if (open && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMentionList(); return; }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalCardId) { closeModal(); return; }

  if (e.key === 'Escape' && document.activeElement === cardSearch) {
    cardSearch.value = '';
    searchQuery = '';
    render(lastCards);
    cardSearch.blur();
    return;
  }

  /* "/" jumps to search, same as Trello/GitHub/Slack — but not while
     already typing somewhere, or it would eat the character itself. */
  if (e.key === '/' && !modalCardId) {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    e.preventDefault();
    cardSearch.focus();
  }
});

cardSearchClear.addEventListener('click', () => {
  cardSearch.value = '';
  searchQuery = '';
  render(lastCards);
  cardSearch.focus();
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

cardSearch.addEventListener('input', () => {
  searchQuery = cardSearch.value;
  render(lastCards);
});

/* ---------- backfill: fill in client name + due date for cards filed
   before that worked reliably. Needs an open Trello tab, same as the
   automatic per-notification enrichment. ---------- */

function shortLinkFromUrl(url) {
  const m = /trello\.com\/c\/([^/?#]+)/.exec(url || '');
  return m ? m[1] : '';
}

backfillBtn.addEventListener('click', async () => {
  const targets = Object.values(cardsById).filter((c) => !c.cardId && shortLinkFromUrl(c.url));
  if (!targets.length) {
    statusEl.textContent = 'Nothing to backfill — every card either has this already or has no Trello card to look up.';
    return;
  }
  backfillBtn.disabled = true;
  let done = 0;
  let failed = 0;
  for (const card of targets) {
    backfillBtn.textContent = 'Backfilling ' + (done + failed + 1) + ' of ' + targets.length + '…';
    const shortLink = shortLinkFromUrl(card.url);
    try {
      const got = await QA.cardDetailsFor(shortLink, true);   // explicit click — worth opening a tab for
      if (!got || !got.ok) { failed++; continue; }
      const lab = got.due ? QA.dueLabel(got.due, got.dueComplete) : null;
      await QA.updateCard(card.id, {
        cardId: shortLink,
        context: got.name || card.context || '',
        due: lab ? lab.text : (card.due || '')
      });
      done++;
    } catch (e) {
      failed++;
    }
  }
  backfillBtn.textContent = 'Backfill details';
  backfillBtn.disabled = false;
  await load();   // refresh the board first — load() sets its own status text, so...
  statusEl.textContent = 'Backfilled ' + done + ' of ' + targets.length +
    (failed ? ' (' + failed + ' failed — needs an open Trello tab)' : '') + '.';   // ...overwrite it with the fuller result
});

/* ---------- daily update: one AI-drafted message of which cards are
   being worked on today. Uses the same Gemini key as "Sort mentions"
   (Settings). Nothing is sent anywhere — it just fills a textarea to
   copy from, same "review before it goes anywhere" spirit as the rest
   of this board. Both the button here and the scheduled alarm run
   through background.js's prepareDailyUpdate, so there's one
   implementation instead of two. ---------- */

/* Fire-and-forget messaging to the background page — same pattern as
   followup.js. With no listener Chrome rejects the promise, which is
   expected, not a failure a plain try/catch would catch. */
function tell(msg, cb) {
  try {
    const p = cb ? chrome.runtime.sendMessage(msg, cb) : chrome.runtime.sendMessage(msg);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) {}
}

QA.getDailyUpdate().then((cfg) => {
  updateRecipient.value = cfg.recipient || '';
  updateAuto.checked = !!cfg.on;
  const hh = String(typeof cfg.hour === 'number' ? cfg.hour : 8).padStart(2, '0');
  const mm = String(typeof cfg.minute === 'number' ? cfg.minute : 0).padStart(2, '0');
  updateAutoTime.value = hh + ':' + mm;
});
updateRecipient.addEventListener('change', () => {
  QA.setDailyUpdate({ recipient: updateRecipient.value.trim() });
});
updateAuto.addEventListener('change', () => {
  QA.setDailyUpdate({ on: updateAuto.checked }).then(() => tell({ type: 'rescheduleDailyUpdate' }));
});
updateAutoTime.addEventListener('change', () => {
  const bits = (updateAutoTime.value || '08:00').split(':').map(Number);
  QA.setDailyUpdate({ hour: bits[0] || 0, minute: bits[1] || 0 }).then(() => tell({ type: 'rescheduleDailyUpdate' }));
});

function showDailyUpdate(draft) {
  if (draft && draft.text) updateText.value = draft.text;
  updateWhen.textContent = draft && draft.at ? 'Generated ' + QA.ago(draft.at) : '';
  if (draft && draft.problem) {
    updateStatus.className = 'meta bad';
    updateStatus.textContent = draft.problem;
  } else {
    updateStatus.className = 'meta';
    updateStatus.textContent = '';
  }
}

function generateDailyUpdate() {
  dailyUpdateBtn.disabled = true;
  updateRegen.disabled = true;
  updatePanel.hidden = false;
  updateStatus.className = 'meta';
  updateStatus.textContent = 'Writing…';
  tell({ type: 'prepareDailyUpdate' }, (draft) => {
    dailyUpdateBtn.disabled = false;
    updateRegen.disabled = false;
    if (!draft) {
      updateStatus.className = 'meta bad';
      updateStatus.textContent = 'Could not write the update.';
      return;
    }
    showDailyUpdate(draft);
  });
}

dailyUpdateBtn.addEventListener('click', generateDailyUpdate);
updateRegen.addEventListener('click', generateDailyUpdate);
updateClose.addEventListener('click', () => { updatePanel.hidden = true; });

updateCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(updateText.value);
  } catch (e) {
    updateText.focus();
    updateText.select();
    document.execCommand('copy');
  }
  updateStatus.className = 'meta ok';
  updateStatus.textContent = 'Copied.';
});

/* a draft from earlier today (manual or scheduled) survives reopening the
   board; from a previous day it's stale, so it's left for "Today's
   update"/the next scheduled run to redo, not shown as if it were fresh */
chrome.storage.local.get({ dailyUpdateDraft: null }).then((got) => {
  const d = got.dailyUpdateDraft;
  if (d && (d.text || d.problem) && new Date(d.at).toDateString() === new Date().toDateString()) {
    showDailyUpdate(d);
    updatePanel.hidden = false;
  }
});

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

/* The board's own periodic refresh no longer needs to avoid the modal — the
   modal is a separate piece of the page from boardEl, so rebuilding the
   board list never touches whatever's open in it. */
function passiveRefresh() {
  if (document.visibilityState === 'visible') load();
}

load();
setInterval(passiveRefresh, 12000);
document.addEventListener('visibilitychange', passiveRefresh);
