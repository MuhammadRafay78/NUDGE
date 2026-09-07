require('dotenv').config();
const express = require('express');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'subscriptions.json');
const BOARD_FILE = path.join(__dirname, 'boards.json');
/* 'waiting' ("Waiting for info") only ever shows up as a column on the
   Action Items board — the client (both boards' cardColumn()) already
   falls back to Doing for any card whose column doesn't exist on its own
   current board, so this list stays a flat, board-agnostic allow-list
   rather than needing to know which board a card is on to validate it. */
const COLUMNS = ['inbox', 'doing', 'waiting', 'done'];
const BOARDS = ['main', 'qtm', 'taxplan', 'actionitems'];
const MAX_COMMENTS = 300;

/* The extension already holds a live, logged-in Trello session — the
   server never has one of its own — so rather than making every viewer of
   the shareable board depend on a separate TRELLO_API_KEY/TOKEN, the
   extension pushes a card's full comment thread here itself whenever it
   fetches one for its own "Open card" panel (see loadHistory in board.js).
   Capped the same way the rest of a card's fields already are, so one
   very chatty card can't blow out storage or the response payload. */
function sanitizeComments(raw) {
  if (!Array.isArray(raw)) return undefined;
  return raw.slice(0, MAX_COMMENTS).map((c) => ({
    at: Number((c && c.at) || 0) || 0,
    by: String((c && c.by) || '').slice(0, 60),
    byName: String((c && c.byName) || '').slice(0, 120),
    text: String((c && c.text) || '').slice(0, 4000)
  }));
}

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

/* Optional, second path — the extension already syncs a card's comment
   thread here itself the moment it fetches one for its own board (see the
   PATCH handler's `comments` field below), so most cards need nothing
   more. This is only for a card nobody's opened in the extension yet: the
   board page has no Trello session of its own (it isn't the extension, so
   it can't read trello.com's cookies), so without either of these it only
   ever shows the one snippet stored on it. Off by default: unset,
   /api/trello-card just says so and the board falls back to whatever's
   already synced, or the stored snippet. See README for how to generate a
   read-only token. */
const TRELLO_API_KEY = process.env.TRELLO_API_KEY || '';
const TRELLO_TOKEN = process.env.TRELLO_TOKEN || '';

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
    dueAt: (patch.dueAt || '').slice(0, 40),
    dueComplete: !!patch.dueComplete,
    cardId: (patch.cardId || '').slice(0, 60),
    notifId: (patch.notifId || '').slice(0, 60),
    actorUser: (patch.actorUser || '').slice(0, 60),
    column: COLUMNS.includes(patch.column) ? patch.column : 'inbox',
    board: BOARDS.includes(patch.board) ? patch.board : 'main',
    createdAt: now,
    updatedAt: now
  };
  cards.unshift(card);
  saveBoards(boards);
  return card;
}

const app = express();
/* 100kb was plenty before a card could carry its own comment thread — a
   busy card's worth of synced comments (see sanitizeComments above) can
   run well past that on its own. */
app.use(express.json({ limit: '2mb' }));

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

/* Read-only mirror of the extension's fetchCardWhole() (common.js) — same
   fields, same shape, just fetched with a server-held key+token over
   Trello's public API instead of injected into an open, logged-in Trello
   tab, since this page has no tab to inject into. Never touches anything
   write-side: no comment, no reaction, no move — TRELLO_TOKEN only ever
   needs read scope for this. */
app.get('/api/trello-card', async (req, res) => {
  if (!TRELLO_API_KEY || !TRELLO_TOKEN) {
    return res.status(501).json({
      ok: false,
      error: 'This server has no Trello credentials set up yet (TRELLO_API_KEY / TRELLO_TOKEN) — see mobile-push/README.md.'
    });
  }
  const cardId = String(req.query.cardId || '');
  if (!cardId) return res.status(400).json({ ok: false, error: 'Missing cardId.' });

  try {
    const url = 'https://api.trello.com/1/cards/' + encodeURIComponent(cardId) +
      '?fields=name' +
      '&actions=commentCard&actions_limit=1000&action_memberCreator_fields=username,fullName' +
      '&key=' + encodeURIComponent(TRELLO_API_KEY) + '&token=' + encodeURIComponent(TRELLO_TOKEN);
    const r = await fetch(url);
    if (!r.ok) return res.status(r.status).json({ ok: false, error: 'Trello said no (' + r.status + ').' });
    const j = await r.json();

    const comments = (Array.isArray(j.actions) ? j.actions : [])
      .filter((a) => a && a.type === 'commentCard')
      .map((a) => ({
        at: Date.parse((a && a.date) || '') || 0,
        by: ((a && a.memberCreator && a.memberCreator.username) || '').toLowerCase(),
        byName: (a && a.memberCreator && a.memberCreator.fullName) || '',
        text: String((a && a.data && a.data.text) || '').replace(/\s+/g, ' ').trim()
      }));

    res.json({ ok: true, comments: comments });
  } catch (e) {
    res.status(502).json({ ok: false, error: String((e && e.message) || e) });
  }
});

app.post('/api/cards', (req, res) => {
  const code = String((req.body && req.body.code) || '').toUpperCase();
  if (!code) return res.status(400).json({ ok: false, error: 'Missing code.' });
  const card = addCard(code, req.body || {});
  res.json({ ok: true, card: card });
});

app.patch('/api/cards/:id', (req, res) => {
  const code = String((req.body && req.body.code) || '').toUpperCase();
  const body = req.body || {};
  if (!code) return res.status(400).json({ ok: false, error: 'Missing code.' });
  if (body.column !== undefined && !COLUMNS.includes(body.column)) {
    return res.status(400).json({ ok: false, error: 'Invalid column.' });
  }
  if (body.board !== undefined && !BOARDS.includes(body.board)) {
    return res.status(400).json({ ok: false, error: 'Invalid board.' });
  }

  const boards = loadBoards();
  const cards = boards[code] || [];
  const card = cards.find((c) => c.id === req.params.id);
  if (!card) return res.status(404).json({ ok: false, error: 'Unknown card.' });

  /* only touches fields actually present in the request — e.g. a backfill
     pass sends {context, due, cardId} without column, a drag/drop sends
     {column} alone */
  if (body.column !== undefined) card.column = body.column;
  if (body.board !== undefined) card.board = body.board;
  if (body.title !== undefined) card.title = String(body.title).slice(0, 200) || 'Untitled';
  if (body.body !== undefined) card.body = String(body.body).slice(0, 4000);
  if (body.context !== undefined) card.context = String(body.context).slice(0, 200);
  if (body.due !== undefined) card.due = String(body.due).slice(0, 40);
  if (body.dueAt !== undefined) card.dueAt = String(body.dueAt).slice(0, 40);
  if (body.dueComplete !== undefined) card.dueComplete = !!body.dueComplete;
  if (body.cardId !== undefined) card.cardId = String(body.cardId).slice(0, 60);
  if (body.notifId !== undefined) card.notifId = String(body.notifId).slice(0, 60);
  if (body.actorUser !== undefined) card.actorUser = String(body.actorUser).slice(0, 60);
  if (body.comments !== undefined) {
    const c = sanitizeComments(body.comments);
    if (c) { card.comments = c; card.commentsAt = Date.now(); }
  }
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
