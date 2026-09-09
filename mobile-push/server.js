require('dotenv').config();
const express = require('express');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'subscriptions.json');
const BOARD_FILE = path.join(__dirname, 'boards.json');
const CUSTOM_BOARDS_FILE = path.join(__dirname, 'customBoards.json');
const MAX_CUSTOM_BOARDS = 40;
/* 'waiting' ("Waiting for info") only ever shows up as a column on the
   Action Items board — the client (both boards' cardColumn()) already
   falls back to Doing for any card whose column doesn't exist on its own
   current board, so this list stays a flat, board-agnostic allow-list
   rather than needing to know which board a card is on to validate it. */
const COLUMNS = ['inbox', 'doing', 'waiting', 'waitingteam', 'waitingdwight', 'done'];
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

/* Optional, third piece — a Gemini-backed chat grounded in this code's own
   board cards, mirroring the extension's "Ask the board" (common.js,
   askGeminiAboutBoard/buildBoardChatContext) for the shareable link, which
   has no Gemini key of its own to hold. Off by default, same spirit as the
   Trello credentials above: unset, /api/ask just says so. */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const BOARD_LABELS = { main: 'Main', qtm: 'QTM', taxplan: 'Tax Plan Draft', actionitems: 'Action Items' };
const COLUMN_LABELS = { inbox: 'Inbox', doing: 'Doing', waiting: 'Awaiting client', waitingteam: 'Awaiting team', waitingdwight: 'Waiting for Dwight', done: 'Done' };
const ACTION_ITEMS_COLUMN_IDS = ['inbox', 'doing', 'waiting', 'waitingteam', 'done'];
const DEFAULT_COLUMN_IDS = ['inbox', 'doing', 'done'];
/* Sending every synced comment thread in full, for every card, is what
   makes a 20-30 card board slow to answer at all — most of that bulk is
   rarely what a given question is actually about. Headers (board/column/
   due date/name) are cheap and always included, uncapped, so "is X on the
   board" is never wrong just because some other card's comment thread
   used up the budget first. MAX_CHAT_DETAIL is what actually limits the
   much heavier notes/comments — once it's spent, later cards still get
   their header line, just without the detail underneath.
   MAX_CHAT_CONTEXT below is only a backstop against a pathological number
   of cards, not a real budget. */
const MAX_CHAT_DETAIL = 16000;
const MAX_CHAT_CONTEXT = 60000;

const BOARD_CHAT_SYSTEM = [
  'You help a tax professional (Rafay, Trello handle @rafay10) work through his Nudge Kanban board.',
  'You are given a CONTEXT block: every card currently on the board he is looking at — its board (Main/QTM/Tax Plan Draft/Action Items), column, due date, its own note, and its comment thread where one has been synced.',
  'Rules:',
  '1. Answer ONLY from the CONTEXT. Never invent a card, client, date, or comment.',
  '2. If the answer is not in the CONTEXT, say so plainly rather than guessing.',
  '3. Match the answer to the question. A direct lookup — "is X on the board?", "when is Y due?", "how many cards are overdue?" — gets a direct, short answer, no padding. An open question about where a card or the board stands gets the fuller picture: current status, who is waiting on what, what is blocking it, and what happens next, so he is not left needing a follow-up for the part that actually matters. Never inflate a simple question, and never flatten a real "where does this stand" into one shallow line.',
  '4. A card\'s comment thread is in time order, oldest to newest. When comments disagree or the situation moved on, the most recent comment is the current truth — answer with what is true now, and bring up an earlier state only when the change itself is the point (e.g. "the client promised it on the 28th but has since gone quiet").',
  '5. Structure it for readability rather than one dense paragraph: when an answer has a few distinct parts (status, blockers, next step), put each on its own line starting with "- ", the way you would jot a quick list. Never number them, never restate the CONTEXT field-by-field or mirror its bracket/label shape.',
  '6. Quote an exact phrase only when the specific wording matters; otherwise say it in your own words.',
  '7. When asked what needs attention, prefer overdue and soon-due cards first. Use the TODAY value at the top of the CONTEXT to reason about "today", "this week", overdue, and how long something has been sitting.',
  '8. Never use markdown — no **bold**, no asterisks for emphasis, no # headers. A leading "- " for a list line, as in rule 5, is the only structure allowed.'
].join('\n');

/* Same shape as the extension's buildBoardChatContext (common.js) — kept in
   sync by hand since this server has no access to that file. */
function buildBoardChatContext(cards, boardLabels) {
  const labels = boardLabels || BOARD_LABELS;
  const list = cards || [];
  const out = ['TODAY: ' + new Date().toString(), '', 'BOARD CARDS (' + list.length + ' total):'];
  let detailBudget = MAX_CHAT_DETAIL;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const boardId = labels[c.board] ? c.board : 'main';
    const colIds = boardId === 'actionitems' ? ACTION_ITEMS_COLUMN_IDS : DEFAULT_COLUMN_IDS;
    const colId = colIds.includes(c.column) ? c.column : 'doing';
    const name = c.context || c.title || 'Untitled';
    out.push('- [' + (labels[boardId] || boardId) + ' / ' + (COLUMN_LABELS[colId] || colId) + ']' +
      (c.due ? ' DUE: ' + c.due : '') + ' ' + name);
    if (detailBudget <= 0) continue;
    const note = String(c.body || '').replace(/\s+/g, ' ').trim();
    if (note) {
      const line = '  NOTE: ' + note.slice(0, 300);
      out.push(line);
      detailBudget -= line.length;
    }
    if (Array.isArray(c.comments) && c.comments.length) {
      c.comments.slice().sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 5).forEach((cm) => {
        if (detailBudget <= 0) return;
        const text = String(cm.text || '').replace(/\s+/g, ' ').trim();
        if (!text) return;
        const line = '  COMMENT (' + (cm.byName || cm.by || 'someone') + '): ' + text.slice(0, 300);
        out.push(line);
        detailBudget -= line.length;
      });
    }
  }
  let ctx = out.join('\n');
  if (ctx.length > MAX_CHAT_CONTEXT) ctx = ctx.slice(0, MAX_CHAT_CONTEXT) + '\n…(truncated)';
  return ctx;
}

function geminiErrorMessage(status, detail) {
  if (status === 400 && /API key not valid/i.test(detail || '')) return 'That Gemini key was not accepted.';
  if (status === 401 || status === 403) return 'That Gemini key was not accepted.';
  if (status === 429) return 'Gemini is rate-limiting — try again shortly.';
  if (status >= 500) return 'Google had a problem (' + status + ').';
  return 'Gemini said no (' + status + ')' + (detail ? ': ' + detail.slice(0, 120) : '');
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

/* ---------- custom board tabs, added by name from outside Nudge ----------
   The built-in four (BOARDS above) are fixed; this is for a tab added by
   something else entirely — a Google Sheet's Apps Script trigger POSTing
   here is the case README.md walks through, but anything that already has
   the pairing code can add one. Kept in its own file, one list per code,
   rather than folded into boards.json's card-list shape, so that shape
   never has to change to fit this. */

function loadCustomBoards() {
  try { return JSON.parse(fs.readFileSync(CUSTOM_BOARDS_FILE, 'utf8')); } catch (e) { return {}; }
}

function saveCustomBoards(data) {
  fs.writeFileSync(CUSTOM_BOARDS_FILE, JSON.stringify(data, null, 2));
}

function slugifyBoardName(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24);
}

/* Every board id valid for this code right now — the fixed four plus
   whatever's been added for it — used to validate a card's `board` field
   the same way BOARDS alone used to. */
function allBoardIds(code) {
  return BOARDS.concat((loadCustomBoards()[code] || []).map((b) => b.id));
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
    board: allBoardIds(code).includes(patch.board) ? patch.board : 'main',
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
  res.json({ ok: true, cards: boards[code] || [], customBoards: loadCustomBoards()[code] || [] });
});

/* Lets something outside Nudge add a board tab by name — a Google Sheet's
   Apps Script trigger POSTing here on every new row is the case
   README.md walks through ("Add a board from a Google Sheet"), so a new
   tab shows up on that code's board without anyone touching the extension
   or this server by hand. The pairing code is the only credential this
   needs, same as every other endpoint here — anyone who already has it
   can already read and write that code's cards. Upserts by slug, so
   sending the same name again (a trigger re-firing, a row edited back to
   what it was) relabels the existing tab instead of duplicating it. */
app.post('/api/boards', (req, res) => {
  const code = String((req.body && req.body.code) || '').toUpperCase();
  if (!code) return res.status(400).json({ ok: false, error: 'Missing code.' });
  const name = String((req.body && req.body.name) || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ ok: false, error: 'Missing board name.' });
  const id = slugifyBoardName(name);
  if (!id) return res.status(400).json({ ok: false, error: 'That name has no letters or numbers to build a board id from.' });
  if (BOARDS.includes(id)) return res.status(400).json({ ok: false, error: 'That name collides with a built-in board.' });

  const all = loadCustomBoards();
  const list = all[code] || (all[code] = []);
  const existing = list.find((b) => b.id === id);
  if (existing) {
    existing.label = name;
  } else {
    if (list.length >= MAX_CUSTOM_BOARDS) {
      return res.status(400).json({ ok: false, error: 'Already at the limit of ' + MAX_CUSTOM_BOARDS + ' custom boards for this code.' });
    }
    list.push({ id: id, label: name, addedAt: Date.now() });
  }
  saveCustomBoards(all);
  res.json({ ok: true, board: { id: id, label: name } });
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

/* The shareable board's own "Ask the board" — same idea as the extension's
   (common.js, askGeminiAboutBoard), just run here since this page has no
   Gemini key of its own to hold. Builds the context itself from this
   code's stored cards rather than trusting whatever the client sends, so
   the grounding always matches what's actually on the board. */
app.post('/api/ask', async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(501).json({
      ok: false,
      error: 'This server has no Gemini key set up yet (GEMINI_API_KEY) — see mobile-push/README.md.'
    });
  }
  const code = String((req.body && req.body.code) || '').toUpperCase();
  if (!code) return res.status(400).json({ ok: false, error: 'Missing code.' });
  const question = String((req.body && req.body.question) || '').trim();
  if (!question) return res.status(400).json({ ok: false, error: 'Missing question.' });
  const history = Array.isArray(req.body && req.body.history) ? req.body.history : [];

  const boards = loadBoards();
  const boardLabels = Object.assign({}, BOARD_LABELS);
  (loadCustomBoards()[code] || []).forEach((b) => { boardLabels[b.id] = b.label; });
  const context = buildBoardChatContext(boards[code] || [], boardLabels);

  const contents = [];
  history.slice(-6).forEach((h) => {
    if (h && h.content) contents.push({ role: h.role === 'user' ? 'user' : 'model', parts: [{ text: String(h.content) }] });
  });
  contents.push({
    role: 'user',
    parts: [{ text: 'CONTEXT (the only data you may use):\n' + context + '\n\nQUESTION: ' + question }]
  });

  try {
    const r = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: BOARD_CHAT_SYSTEM }] },
          contents: contents,
          /* Mirrors the extension's askGeminiAboutBoard: a bounded thinking
             budget (not the old thinkingBudget: 0) so answers reason across
             cards instead of coming back shallow, with enough output
             headroom that a multi-card answer never gets cut off
             mid-sentence — the failure the old small cap hit. */
          generationConfig: { temperature: 0.3, maxOutputTokens: 3000, thinkingConfig: { thinkingBudget: 1024 } }
        })
      }
    );
    if (!r.ok) {
      let detail = '';
      try { const b = await r.json(); detail = (b && b.error && b.error.message) || ''; } catch (e) {}
      return res.status(r.status).json({ ok: false, error: geminiErrorMessage(r.status, detail) });
    }
    const body = await r.json();
    const parts = (((body.candidates || [])[0] || {}).content || {}).parts || [];
    const answer = parts.map((p) => p.text || '').join('').trim();
    res.json({ ok: true, answer: answer || '(no answer)' });
  } catch (e) {
    res.status(502).json({ ok: false, error: 'Could not reach Gemini: ' + String((e && e.message) || e) });
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
  if (body.board !== undefined && !allBoardIds(code).includes(body.board)) {
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
