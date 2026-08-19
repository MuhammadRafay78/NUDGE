const COLUMNS = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'doing', label: 'Doing' },
  { id: 'action', label: 'Action Items' },
  { id: 'done', label: 'Done' }
];

const code = localStorage.getItem('nudgeCode');
const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status');
const newTitle = document.getElementById('newTitle');
const addBtn = document.getElementById('addBtn');
const modalEl = document.getElementById('cardModal');
const modalBoxEl = document.getElementById('cardModalBox');

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

async function deleteCard(id) {
  await api('/api/cards/' + encodeURIComponent(id), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code })
  });
}

async function addCard(title) {
  await api('/api/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code, title: title, column: 'doing' })
  });
}

function itemHtml(card) {
  const openLink = card.url ? '<a class="open" href="' + esc(card.url) + '" target="_blank" rel="noreferrer">Trello &#8599;</a>' : '';
  const options = COLUMNS.map((c) =>
    '<option value="' + c.id + '"' + (c.id === card.column ? ' selected' : '') + '>' + c.label + '</option>'
  ).join('');
  const body = card.body || '';
  /* Lead with the client/card name — that's what matters at a glance. The
     generic "X tagged you" line becomes a small byline underneath (or, for a
     hand-typed card with no client name yet, it's all there is). */
  const heading = card.context || card.title;
  const byline = card.context ? card.title : '';
  return (
    '<div class="item" data-id="' + esc(card.id) + '">' +
      '<div class="t">' + esc(heading) + '</div>' +
      (byline ? '<div class="sub">' + esc(byline) + '</div>' : '') +
      (card.due ? '<div class="due">' + esc(card.due) + '</div>' : '') +
      (body ? '<div class="b">' + esc(body) + '</div>' : '') +
      '<div class="meta">' +
        '<span class="when">' + ago(card.updatedAt || card.createdAt) + '</span>' +
        openLink +
        '<select class="move">' + options + '</select>' +
        '<button class="del" title="Delete">&times;</button>' +
      '</div>' +
    '</div>'
  );
}

/* ---------- "Open card" ----------
   A tile only ever showed a 3-line preview with no way to see the rest —
   tapping it now opens the full card. Same dense-note formatting as the
   extension's board: a bold line ending in ":" is a section header, any
   other bold-only line or a " - " item is a bullet under it, everything
   else is a plain line. Nothing here can post back to Trello — this phone
   has no Trello session — so the way to actually reply is the "Trello ↗"
   link, which opens the real card. */

function formatBodyHtml(text) {
  if (!text) return '<div class="empty">Nothing else on this card.</div>';
  let t = esc(text);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  t = t.replace(/(.)(<b>)/g, '$1\n$2');
  t = t.replace(/ - (?=\S)/g, '\n- ');
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

function modalHtml(card) {
  const heading = card.context || card.title;
  const byline = card.context ? card.title : '';
  const trelloLink = card.url
    ? '<a class="open" href="' + esc(card.url) + '" target="_blank" rel="noreferrer">Reply on Trello &#8599;</a>'
    : '';
  return (
    '<div class="modal-head">' +
      '<button class="modal-close" title="Close">&times;</button>' +
      '<div class="t">' + esc(heading) + '</div>' +
      (byline ? '<div class="sub">' + esc(byline) + '</div>' : '') +
      (card.due ? '<div class="due">' + esc(card.due) + '</div>' : '') +
      trelloLink +
    '</div>' +
    '<div class="modal-body">' + formatBodyHtml(card.body) + '</div>'
  );
}

let modalCardId = null;
let cardsById = {};

function openModal(id) {
  const card = cardsById[id];
  if (!card) return;
  modalCardId = id;
  modalBoxEl.innerHTML = modalHtml(card);
  modalEl.hidden = false;
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

function render(cards) {
  cardsById = {};
  cards.forEach((c) => { cardsById[c.id] = c; });
  if (modalCardId && !cardsById[modalCardId]) closeModal();   // card moved/deleted elsewhere

  boardEl.innerHTML = COLUMNS.map((col) => {
    const items = cards.filter((c) => c.column === col.id);
    return (
      '<div class="col" data-col="' + col.id + '">' +
        '<h2>' + col.label + ' <span class="n">' + items.length + '</span></h2>' +
        (items.length ? items.map(itemHtml).join('') : '<div class="empty">Nothing here.</div>') +
      '</div>'
    );
  }).join('');

  if (modalCardId) modalBoxEl.innerHTML = modalHtml(cardsById[modalCardId]);   // keep it in sync while open
}

boardEl.addEventListener('change', async (e) => {
  if (!e.target.classList.contains('move')) return;
  const id = e.target.closest('.item').dataset.id;
  try {
    await moveCard(id, e.target.value);
    load();
  } catch (err) {
    statusEl.textContent = 'Could not move: ' + err.message;
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

addBtn.addEventListener('click', async () => {
  const title = newTitle.value.trim();
  if (!title) return;
  addBtn.disabled = true;
  try {
    await addCard(title);
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
