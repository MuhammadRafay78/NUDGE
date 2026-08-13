/* Kanban board — same server + pairing code as the phone relay (Settings > Mobile notifications). */

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status');
const warnEl = document.getElementById('notConfigured');
const newTitle = document.getElementById('newTitle');
const addBtn = document.getElementById('addBtn');

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const LONG_BODY = 140;   // roughly where a 3-line clamp starts hiding text
const expanded = new Set();   // card ids currently showing full text, survives a refresh
let dragging = false;         // suppress auto-refresh mid-drag so the drop target doesn't vanish

function itemHtml(card) {
  const openLink = card.url ? '<a class="open" href="' + esc(card.url) + '" target="_blank" rel="noreferrer">Open &rarr;</a>' : '';
  const options = QA.BOARD_COLUMNS.map((c) =>
    '<option value="' + c.id + '"' + (c.id === card.column ? ' selected' : '') + '>' + c.label + '</option>'
  ).join('');
  const body = card.body || '';
  const long = body.length > LONG_BODY;
  const isOpen = expanded.has(card.id);
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
        '<select class="move">' + options + '</select>' +
        '<button class="del" title="Delete">&times;</button>' +
      '</div>' +
    '</div>'
  );
}

function render(cards) {
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

boardEl.addEventListener('click', async (e) => {
  if (e.target.classList.contains('more')) {
    const id = e.target.closest('.item').dataset.id;
    const b = e.target.previousElementSibling;
    const collapsed = b.classList.toggle('clamp');
    if (collapsed) expanded.delete(id); else expanded.add(id);
    e.target.textContent = collapsed ? 'Show more' : 'Show less';
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
    await QA.createCard(title, '', '', 'doing');
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

load();
setInterval(() => { if (document.visibilityState === 'visible') load(); }, 12000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });
