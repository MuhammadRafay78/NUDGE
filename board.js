/* Kanban board — same server + pairing code as the phone relay (Settings > Mobile notifications). */

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status');
const warnEl = document.getElementById('notConfigured');
const newTitle = document.getElementById('newTitle');
const addBtn = document.getElementById('addBtn');
const backfillBtn = document.getElementById('backfillBtn');
const modalEl = document.getElementById('cardModal');
const modalBoxEl = document.getElementById('cardModalBox');

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
let cardsById = {};            // last-rendered cards
const peopleCache = {};        // cardId -> [{username, fullName}], fetched once per open
let modalCardId = null;          // which card's "Open card" modal is showing, or null
const historyCache = {};         // card id -> { loading } | { ok:true, comments } | { ok:false, error }
const replyDefaultUser = {};     // card id -> username to @mention, when replying to a specific comment
                                  // instead of the card's original tagger
let replyDraft = null;           // live text of the modal's reply box — the modal is a separate DOM
                                  // tree from the board, so a board refresh never touches it, but the
                                  // modal's own comment-list reload does rebuild it, hence tracking this

function defaultReplyUser(card) {
  return replyDefaultUser[card.id] || card.actorUser || '';
}

function itemHtml(card) {
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
  return (
    /* draggable="true" is the only way to move a card between columns now —
       the handle is just a visual cue for that, grabbing anywhere else on
       the card (that isn't itself a button/link) works exactly the same.
       Clicking anywhere on the card that isn't a control opens it — same as
       clicking "Open card" — see the boardEl click handler below. */
    '<div class="item" data-id="' + esc(card.id) + '" draggable="true">' +
      '<span class="handle" title="Drag to move between columns" aria-hidden="true">&#8942;&#8942;</span>' +
      '<div class="t" title="' + esc(heading) + '">' + esc(heading) + '</div>' +
      (byline ? '<div class="sub">' + esc(byline) + '</div>' : '') +
      (card.due ? '<div class="due">' + esc(card.due) + '</div>' : '') +
      (body ? '<div class="b' + (isOpen ? '' : ' clamp') + '">' + esc(body) + '</div>' : '') +
      (long ? '<button class="more">' + (isOpen ? 'Show less' : 'Show more') + '</button>' : '') +
      (canReply ? reactRowHtml() : '') +
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
      '<div class="row2">' +
        '<span class="when">' + QA.ago(card.updatedAt || card.createdAt) + '</span>' +
        '<button class="del" title="Delete">&times;</button>' +
      '</div>' +
    '</div>'
  );
}

/* Reactions on the card's own tagged comment — mirrors the popup's react row.
   Matching happens by comment text (see QA.reactToMention), so this needs no
   action id up front. */
function reactRowHtml() {
  const btns = QA.REACTIONS.map((r) =>
    '<button class="emo" data-emoji="' + esc(r.emoji) + '" title="' + esc(r.label) + ' — react on this comment in Trello">' + r.emoji + '</button>'
  ).join('');
  return '<div class="react">' + btns + '<span class="rnote" data-role="rstatus"></span></div>';
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
  return (
    '<div class="modal-item" data-idx="' + i + '">' +
      '<div class="hist-meta"><b>' + esc(who) + '</b>' + (when ? ' &middot; ' + esc(when) : '') + '</div>' +
      '<div class="hist-text">' + esc(QA.tidyCommentText(c.text)) + '</div>' +
      '<div class="hist-acts">' + reactBtns +
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
      '<textarea class="reply-in" rows="2" placeholder="Reply… type @ to tag someone">' + esc(defaultText) + '</textarea>' +
      '<div class="mention-list" hidden></div>' +
    '</div>' +
    '<div class="reply-acts">' +
      '<button class="btn go send-reply">Send reply</button>' +
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
      error: (res && res.error) || (res && res.status ? 'Trello said no (' + res.status + ').' : 'Needs an open Trello tab — open trello.com in another tab, then try again.')
    };
  }
  if (modalCardId === id) renderModal(focusComposer);
}

function render(cards) {
  cardsById = {};
  cards.forEach((c) => { cardsById[c.id] = c; });
  if (modalCardId && !cardsById[modalCardId]) closeModal();   // card deleted elsewhere

  boardEl.innerHTML = QA.BOARD_COLUMNS.map((col) => {
    const items = cards.filter((c) => c.column === col.id);
    return (
      '<div class="col" data-col="' + col.id + '">' +
        '<h2>' + col.label + ' <span class="n">' + items.length + '</span></h2>' +
        (items.length ? items.map(itemHtml).join('') : '<div class="empty">Nothing here.</div>') +
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
  if (!text || text === '@' + defaultReplyUser(card)) { ta.focus(); return; }
  sendBtn.disabled = true;
  status.className = 'reply-status';
  status.textContent = 'Sending…';
  const res = await QA.replyToCard(card.cardId, text);
  if (res && res.ok) {
    status.textContent = 'Sent';
    replyDraft = null;
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

/* Reacting to the card's own tagged comment (the board card's react row —
   the modal's per-comment reactions are handled separately, in the modal's
   own click handler below). */
async function handleReactClick(e) {
  const item = e.target.closest('.item');
  const card = cardsById[item.dataset.id];
  if (!card) return;
  const r = QA.REACTIONS.filter((x) => x.emoji === e.target.dataset.emoji)[0];
  if (!r) return;

  const target = { cardId: card.cardId, text: card.body || card.title || '', actorUser: card.actorUser };
  const scope = e.target.closest('.react');
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

  if (e.target.classList.contains('emo')) {
    await handleReactClick(e);
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
  const item = e.target.closest('.item');
  const card = item && cardsById[item.dataset.id];
  if (!card || !card.cardId) return;
  if (window.getSelection && String(window.getSelection())) return;   // was selecting text, not clicking
  openModal(item.dataset.id, false);
});

/* ---------- the "Open card" modal itself ---------- */

modalEl.addEventListener('click', async (e) => {
  if (e.target === modalEl || e.target.classList.contains('modal-close')) {
    closeModal();
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
  if (e.key === 'Escape' && modalCardId) closeModal();
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
      const got = await QA.cardDetailsFor(shortLink);
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
