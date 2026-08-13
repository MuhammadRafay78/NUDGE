require('dotenv').config();
const express = require('express');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'subscriptions.json');
const BOARD_FILE = path.join(__dirname, 'boards.json');
const COLUMNS = ['inbox', 'doing', 'action', 'done'];

/* excludes 0/O/1/I/L so a code read aloud or copied by hand isn't ambiguous */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:you@example.com';

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('Missing VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY.');
  console.error('Run: npm run generate-vapid   (then put the keys in .env)');
  process.exit(1);
}

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

function loadStore() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { return {}; }
}

function saveStore(store) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

function newCode(store) {
  let code;
  do {
    code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  } while (store[code]);
  return code;
}

/* ---------- board (Kanban cards), one card list per pairing code ---------- */

function loadBoards() {
  try { return JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8')); } catch (e) { return {}; }
}

function saveBoards(boards) {
  fs.writeFileSync(BOARD_FILE, JSON.stringify(boards, null, 2));
}

function addCard(code, patch) {
  const boards = loadBoards();
  const cards = boards[code] || (boards[code] = []);
  const now = Date.now();
  const card = {
    id: crypto.randomUUID(),
    title: (patch.title || '').slice(0, 200) || 'Untitled',
    body: (patch.body || '').slice(0, 4000),
    url: patch.url || '',
    context: (patch.context || '').slice(0, 200),
    due: (patch.due || '').slice(0, 40),
    column: COLUMNS.includes(patch.column) ? patch.column : 'inbox',
    createdAt: now,
    updatedAt: now
  };
  cards.unshift(card);
  saveBoards(boards);
  return card;
}

const app = express();
app.use(express.json({ limit: '100kb' }));

/* extensions with host_permissions bypass CORS anyway, but the pairing page
   itself may be opened from a different origin during development */
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/register', (req, res) => {
  const subscription = req.body && req.body.subscription;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ ok: false, error: 'Missing subscription.' });
  }
  const store = loadStore();
  const code = newCode(store);
  store[code] = { subscription: subscription, createdAt: Date.now() };
  saveStore(store);
  res.json({ ok: true, code: code });
});

app.post('/api/unpair', (req, res) => {
  const code = String((req.body && req.body.code) || '').toUpperCase();
  const store = loadStore();
  if (store[code]) { delete store[code]; saveStore(store); }
  res.json({ ok: true });
});

app.post('/api/notify', async (req, res) => {
  const code = String((req.body && req.body.code) || '').toUpperCase();
  const title = (req.body && req.body.title) || 'Nudge';
  const body = (req.body && req.body.body) || '';
  const url = (req.body && req.body.url) || '';
  if (!code) return res.status(400).json({ ok: false, error: 'Missing pairing code.' });

  const store = loadStore();
  const entry = store[code];
  if (!entry) return res.status(404).json({ ok: false, error: 'Unknown pairing code.' });

  try {
    await webpush.sendNotification(entry.subscription, JSON.stringify({ title: title, body: body, url: url }));
    res.json({ ok: true });
  } catch (e) {
    if (e && (e.statusCode === 404 || e.statusCode === 410)) {
      delete store[code];
      saveStore(store);
      return res.status(410).json({ ok: false, error: 'That phone unsubscribed or the pairing expired — pair again.' });
    }
    res.status(502).json({ ok: false, error: String((e && e.message) || e) });
  }
});

app.get('/api/cards', (req, res) => {
  const code = String(req.query.code || '').toUpperCase();
  if (!code) return res.status(400).json({ ok: false, error: 'Missing code.' });
  const boards = loadBoards();
  res.json({ ok: true, cards: boards[code] || [] });
});

app.post('/api/cards', (req, res) => {
  const code = String((req.body && req.body.code) || '').toUpperCase();
  if (!code) return res.status(400).json({ ok: false, error: 'Missing code.' });
  const card = addCard(code, req.body || {});
  res.json({ ok: true, card: card });
});

app.patch('/api/cards/:id', (req, res) => {
  const code = String((req.body && req.body.code) || '').toUpperCase();
  const column = req.body && req.body.column;
  if (!code) return res.status(400).json({ ok: false, error: 'Missing code.' });
  if (!COLUMNS.includes(column)) return res.status(400).json({ ok: false, error: 'Invalid column.' });

  const boards = loadBoards();
  const cards = boards[code] || [];
  const card = cards.find((c) => c.id === req.params.id);
  if (!card) return res.status(404).json({ ok: false, error: 'Unknown card.' });

  card.column = column;
  card.updatedAt = Date.now();
  saveBoards(boards);
  res.json({ ok: true, card: card });
});

app.delete('/api/cards/:id', (req, res) => {
  const code = String((req.body && req.body.code) || '').toUpperCase();
  if (!code) return res.status(400).json({ ok: false, error: 'Missing code.' });

  const boards = loadBoards();
  const cards = boards[code] || [];
  const next = cards.filter((c) => c.id !== req.params.id);
  boards[code] = next;
  saveBoards(boards);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log('Nudge mobile push server listening on port ' + PORT);
});
