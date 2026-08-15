/* Kanban board — same server + pairing code as the phone relay (Settings > Mobile notifications). */

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status');
const warnEl = document.getElementById('notConfigured');
const newTitle = document.getElementById('newTitle');
const addBtn = document.getElementById('addBtn');
const backfillBtn = document.getElementById('backfillBtn');

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
const historyOpen = new Set();   // card ids currently showing the comments/activity panel
const historyCache = {};         // card id -> { loading } | { ok:true, comments } | { ok:false, error }
const replyDefaultUser = {};     // card id -> username to @mention, when replying from a specific
                                  // history comment instead of the card's original tagger

function defaultReplyUser(card) {
  return replyDefaultUser[card.id] || card.actorUser || '';
}

function itemHtml(card) {
  /* A separate, clearly-labelled escape hatch to the real Trello page — kept
     small and secondary, since "Open card" below now stays on the board
     (it used to be the one that dropped you onto trello.com, which is
     exactly the surprise the comments/activity panel was built to avoid). */
  const trelloLink = card.url
    ? '<a class="open" href="' + esc(card.url) + '" target="_blank" rel="noreferrer" title="Open the real card on trello.com">Trello &#8599;</a>'
    : '';
  const body = card.body || '';
  const long = body.length > LONG_BODY;
  const isOpen = expanded.has(card.id);
  const canReply = !!card.cardId;
  const histOpen = historyOpen.has(card.id);
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
      '<div class="t">' + esc(heading) + '</div>' +
      (byline ? '<div class="sub">' + esc(byline) + '</div>' : '') +
      (card.due ? '<div class="due">' + esc(card.due) + '</div>' : '') +
      (body ? '<div class="b' + (isOpen ? '' : ' clamp') + '">' + esc(body) + '</div>' : '') +
      (long ? '<button class="more">' + (isOpen ? 'Show less' : 'Show more') + '</button>' : '') +
      (canReply ? reactRowHtml() : '') +
      /* Action pills get their own row so they can wrap on a narrow card
         without ever pulling "when"/delete along with them — those two stay
         paired on a fixed, always-two-item row underneath (see .row2 below),
         so delete never ends up stranded alone on its own line. */
      (canReply || trelloLink ? (
        '<div class="acts">' +
          (canReply ? '<button class="hist-btn">' + (histOpen ? 'Hide' : 'Open card') + '</button>' : '') +
          (canReply ? '<button class="reply-btn">' + (replyingId === card.id ? 'Cancel' : 'Reply') + '</button>' : '') +
          trelloLink +
        '</div>'
      ) : '') +
      '<div class="row2">' +
        '<span class="when">' + QA.ago(card.updatedAt || card.createdAt) + '</span>' +
        '<button class="del" title="Delete">&times;</button>' +
      '</div>' +
      (canReply && histOpen ? historyHtml(card) : '') +
      (replyingId === card.id ? replyBoxHtml(card) : '') +
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

/* The whole card, expanded inline — the same "open it and see everything" feel
   as clicking a card open in Trello itself, without leaving the board:
   description, checklist progress, then the full comment feed. Each comment
   gets its own reactions and a Reply link that pre-fills @ whoever wrote THAT
   comment, not just the card's original tagger. */
function historyHtml(card) {
  const cache = historyCache[card.id];
  if (!cache || cache.loading) return '<div class="hist"><div class="hist-status">Loading…</div></div>';
  if (!cache.ok) {
    return '<div class="hist"><div class="hist-status bad">&#9888; ' +
      esc(cache.error || 'Could not load this card.') + '</div></div>';
  }

  const summary = [];
  if (cache.desc) summary.push('<div class="hist-desc">' + esc(cache.desc) + '</div>');
  if (cache.checklist && cache.checklist.length) {
    const done = cache.checklist.filter((it) => it.done).length;
    const openItems = cache.checklist.filter((it) => !it.done)
      .map((it) => '<li>' + esc(it.name) + '</li>').join('');
    summary.push(
      '<div class="hist-checklist">' +
        '<div class="hist-checklist-n">Checklist &middot; ' + done + '/' + cache.checklist.length + ' done</div>' +
        (openItems ? '<ul>' + openItems + '</ul>' : '') +
      '</div>'
    );
  }

  const comments = cache.comments || [];
  const rows = comments.length
    ? comments.map((c, i) => {
        const when = c.at ? QA.ago(c.at) : '';
        const who = c.byName || c.by || 'Someone';
        const reactBtns = QA.REACTIONS.map((r) =>
          '<button class="emo hist-emo" data-emoji="' + esc(r.emoji) + '" title="' + esc(r.label) + '">' + r.emoji + '</button>'
        ).join('');
        return (
          '<div class="hist-item" data-idx="' + i + '">' +
            '<div class="hist-meta"><b>' + esc(who) + '</b>' + (when ? ' &middot; ' + esc(when) : '') + '</div>' +
            '<div class="hist-text">' + esc(QA.tidyCommentText(c.text)) + '</div>' +
            '<div class="hist-acts">' + reactBtns +
              '<button class="hist-reply-btn">Reply</button>' +
              '<span class="rnote"></span>' +
            '</div>' +
          '</div>'
        );
      }).join('')
    : '<div class="hist-status">No comments yet on this card.</div>';

  return '<div class="hist">' + summary.join('') + rows + '</div>';
}

function replyBoxHtml(card) {
  const quick = QA.QUICK_REPLIES.map((q) =>
    '<button class="chip" data-q="' + esc(q) + '">' + esc(q) + '</button>'
  ).join('');
  const defaultUser = defaultReplyUser(card);
  const defaultText = defaultUser ? '@' + defaultUser + ' ' : '';
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

function toggleHistory(id) {
  if (historyOpen.has(id)) {
    historyOpen.delete(id);
    render(Object.values(cardsById));
  } else {
    historyOpen.add(id);
    delete historyCache[id];   // always fetch fresh on open, so a just-sent reply shows up
    render(Object.values(cardsById));
    loadHistory(id);
  }
}

async function loadHistory(id) {
  const card = cardsById[id];
  if (!card || !card.cardId) return;
  historyCache[id] = { loading: true };
  render(Object.values(cardsById));
  const res = await QA.cardWholeFor(card.cardId);
  if (res && res.ok) {
    historyCache[id] = {
      ok: true, desc: res.desc || '', checklist: res.checklist || [],
      comments: (res.comments || []).slice().sort((a, b) => (b.at || 0) - (a.at || 0))
    };
  } else {
    historyCache[id] = {
      ok: false,
      error: (res && res.error) || (res && res.status ? 'Trello said no (' + res.status + ').' : 'Needs an open Trello tab — open trello.com in another tab, then try again.')
    };
  }
  if (historyOpen.has(id)) render(Object.values(cardsById));
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
  if (!text || text === '@' + defaultReplyUser(card)) { ta.focus(); return; }
  sendBtn.disabled = true;
  cancelBtn.disabled = true;
  status.className = 'reply-status';
  status.textContent = 'Sending…';
  const res = await QA.replyToCard(card.cardId, text);
  if (res && res.ok) {
    status.textContent = 'Sent';
    replyingId = null;
    delete replyDefaultUser[card.id];
    if (historyOpen.has(card.id)) { delete historyCache[card.id]; loadHistory(card.id); }
    try { await QA.moveCard(card.id, 'done'); } catch (e) {}
    load();
  } else {
    sendBtn.disabled = false;
    cancelBtn.disabled = false;
    status.className = 'reply-status bad';
    status.textContent = QA.replyErrorMessage(res);
  }
}

/* One reaction click, on either the card's own tagged comment (.emo alone) or
   a specific comment inside the expanded history (.hist-emo, matched by index
   into that card's cached comment feed). */
async function handleReactClick(e) {
  const item = e.target.closest('.item');
  const card = cardsById[item.dataset.id];
  if (!card) return;
  const r = QA.REACTIONS.filter((x) => x.emoji === e.target.dataset.emoji)[0];
  if (!r) return;

  let target;
  let scope;
  if (e.target.classList.contains('hist-emo')) {
    const idx = Number(e.target.closest('.hist-item').dataset.idx);
    const cache = historyCache[card.id];
    const c = cache && cache.ok && cache.comments[idx];
    if (!c) return;
    target = { cardId: card.cardId, text: c.text, actorUser: c.by };
    scope = e.target.closest('.hist-acts');
  } else {
    target = { cardId: card.cardId, text: card.body || card.title || '', actorUser: card.actorUser };
    scope = e.target.closest('.react');
  }

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
    toggleHistory(e.target.closest('.item').dataset.id);
    return;
  }

  if (e.target.classList.contains('hist-reply-btn')) {
    const item = e.target.closest('.item');
    const id = item.dataset.id;
    const idx = Number(e.target.closest('.hist-item').dataset.idx);
    const cache = historyCache[id];
    const c = cache && cache.ok && cache.comments[idx];
    replyDefaultUser[id] = (c && c.by) || '';
    replyingId = id;
    render(Object.values(cardsById));
    return;
  }

  if (e.target.classList.contains('reply-btn')) {
    const id = e.target.closest('.item').dataset.id;
    if (replyingId === id) {
      replyingId = null;
    } else {
      replyingId = id;
      delete replyDefaultUser[id];   // opened from the card itself — default to the original tagger
    }
    render(Object.values(cardsById));
    return;
  }
  if (e.target.classList.contains('cancel-reply')) {
    delete replyDefaultUser[replyingId];
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
    const user = defaultReplyUser(card);
    const at = user ? '@' + user + ' ' : '';
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
     drag handle, blank padding — opens it, same as the "Open card" button.
     Anything that's its own control (buttons/links/inputs above) already
     returned by this point, and clicks inside an already-open history or
     reply panel are left alone so reading/selecting that text doesn't
     collapse it back. */
  if (e.target.closest('.hist') || e.target.closest('.reply')) return;
  const item = e.target.closest('.item');
  const card = item && cardsById[item.dataset.id];
  if (!card || !card.cardId) return;
  if (window.getSelection && String(window.getSelection())) return;   // was selecting text, not clicking
  toggleHistory(item.dataset.id);
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

/* the passive/periodic refresh skips while a reply is open (so a poll never wipes
   text someone's mid-typing) or while a comment history panel is open (so a poll
   never resets someone's scroll position mid-read); an explicit action
   (move/delete/drop/send/expand) on any card still refreshes immediately via its
   own load() or loadHistory() call */
function passiveRefresh() {
  if (document.visibilityState === 'visible' && !replyingId && !historyOpen.size) load();
}

load();
setInterval(passiveRefresh, 12000);
document.addEventListener('visibilitychange', passiveRefresh);
