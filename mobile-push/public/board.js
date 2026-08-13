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
  const openLink = card.url ? '<a class="open" href="' + esc(card.url) + '" target="_blank" rel="noreferrer">Open &rarr;</a>' : '';
  const options = COLUMNS.map((c) =>
    '<option value="' + c.id + '"' + (c.id === card.column ? ' selected' : '') + '>' + c.label + '</option>'
  ).join('');
  return (
    '<div class="item" data-id="' + esc(card.id) + '">' +
      '<div class="t">' + esc(card.title) + '</div>' +
      (card.body ? '<div class="b">' + esc(card.body) + '</div>' : '') +
      '<div class="meta">' +
        '<span class="when">' + ago(card.updatedAt || card.createdAt) + '</span>' +
        openLink +
        '<select class="move">' + options + '</select>' +
        '<button class="del" title="Delete">&times;</button>' +
      '</div>' +
    '</div>'
  );
}

function render(cards) {
  boardEl.innerHTML = COLUMNS.map((col) => {
    const items = cards.filter((c) => c.column === col.id);
    return (
      '<div class="col" data-col="' + col.id + '">' +
        '<h2>' + col.label + ' <span class="n">' + items.length + '</span></h2>' +
        (items.length ? items.map(itemHtml).join('') : '<div class="empty">Nothing here.</div>') +
      '</div>'
    );
  }).join('');
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
  if (!e.target.classList.contains('del')) return;
  const id = e.target.closest('.item').dataset.id;
  try {
    await deleteCard(id);
    load();
  } catch (err) {
    statusEl.textContent = 'Could not delete: ' + err.message;
  }
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
}
