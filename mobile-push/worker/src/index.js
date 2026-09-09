import webPush from 'web-push';

/* excludes 0/O/1/I/L so a code read aloud or copied by hand isn't ambiguous */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;

/* 'waiting' ("Waiting for info") only ever shows up as a column on the
   Action Items board — the client (both boards' cardColumn()) already
   falls back to Doing for any card whose column doesn't exist on its own
   current board, so this list stays a flat, board-agnostic allow-list
   rather than needing to know which board a card is on to validate it. */
const COLUMNS = ['inbox', 'doing', 'waiting', 'waitingteam', 'done'];
const BOARDS = ['main', 'qtm', 'taxplan', 'actionitems'];
const boardKey = (code) => 'board:' + code;
const customBoardsKey = (code) => 'customboards:' + code;
const MAX_COMMENTS = 300;
const MAX_CUSTOM_BOARDS = 40;

/* The extension already holds a live, logged-in Trello session — the
   Worker never has one of its own — so rather than making every viewer of
   the shareable board depend on a separate TRELLO_API_KEY/TOKEN, the
   extension pushes a card's full comment thread here itself whenever it
   fetches one for its own "Open card" panel (see loadHistory in board.js).
   Capped the same way the rest of a card's fields already are, so one
   very chatty card can't blow out KV storage or the response payload. */
function sanitizeComments(raw) {
  if (!Array.isArray(raw)) return undefined;
  return raw.slice(0, MAX_COMMENTS).map((c) => ({
    at: Number((c && c.at) || 0) || 0,
    by: String((c && c.by) || '').slice(0, 60),
    byName: String((c && c.byName) || '').slice(0, 120),
    text: String((c && c.text) || '').slice(0, 4000)
  }));
}

/* Same idea as the extension's "Ask the board" (common.js,
   askGeminiAboutBoard/buildBoardChatContext), run here since this page has
   no Gemini key of its own to hold — mirrors server.js's copy of this,
   kept in sync by hand since Worker and Node don't share a module. */
const BOARD_LABELS = { main: 'Main', qtm: 'QTM', taxplan: 'Tax Plan Draft', actionitems: 'Action Items' };
const COLUMN_LABELS = { inbox: 'Inbox', doing: 'Doing', waiting: 'Awaiting client', waitingteam: 'Awaiting team', done: 'Done' };
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
  '3. Answer the way you would explain it to him out loud, and cover it properly: current status, who is waiting on what, what is blocking it, and what happens next — not just a one-line mention that leaves him needing to ask a follow-up for the part that actually matters.',
  '4. Structure it for readability rather than one dense paragraph: when an answer has a few distinct parts (status, blockers, next step), put each on its own line starting with "- ", the way you would jot a quick list. Never number them, never restate the CONTEXT field-by-field or mirror its bracket/label shape.',
  '5. Quote an exact phrase only when the specific wording matters; otherwise say it in your own words.',
  '6. When asked what needs attention, prefer overdue and soon-due cards first.',
  '7. Never use markdown — no **bold**, no asterisks for emphasis, no # headers. A leading "- " for a list line, as in rule 4, is the only structure allowed.',
  '8. Several cards can belong to similar-sounding people (a shared last name, a couple filed as two separate cards, one name that is a substring of another). Before answering about "X", check the CONTEXT for every card whose name is close to X — if more than one plausibly matches, ask which one he means rather than picking one silently; if only one truly matches, answer about that one specifically and do not blend in details from a different, similarly-named card.',
  '9. For a broad question ("what needs attention", "what is outstanding", "what is not done yet"), do not restate the whole board back to him as a nested board-by-column breakdown. Name individual cards only where naming them is the actual point — the few he can act on right now, or the ones actually blocking something — otherwise summarize a group by its count. A bullet list where most lines are just a count of cards in some column, repeated for every board and every column, is not an answer — it is the CONTEXT read back at him.',
  '10. Every forecast task on the Action Items board is Dwight’s to do. If a card’s forecast is outstanding or comes up, say it is on Dwight rather than treating the owner as unclear or unknown.'
].join('\n');

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

/* "Ask about this card" is a single-card question, not a whole-board one —
   running it through buildBoardChatContext meant it shared that budget
   with every other card on the board, so a comment with real substance
   (several paragraphs, an "Action items — X:" breakdown) got cut to 300
   characters same as everything else, or crowded out entirely if enough
   other cards' comments spent the budget first. A single card is never
   anywhere near that size, so there's no budget to share here. */
function buildSingleCardContext(card) {
  const name = card.context || card.title || 'Untitled';
  const out = ['CARD: ' + name];
  if (card.due) out.push('DUE: ' + card.due);
  const note = String(card.body || '').replace(/\s+/g, ' ').trim();
  if (note) out.push('NOTE: ' + note);
  if (Array.isArray(card.comments) && card.comments.length) {
    card.comments.slice().sort((a, b) => (b.at || 0) - (a.at || 0)).forEach((cm) => {
      const text = String(cm.text || '').replace(/\s+/g, ' ').trim();
      if (text) out.push('COMMENT (' + (cm.byName || cm.by || 'someone') + '): ' + text);
    });
  }
  return out.join('\n');
}

function geminiErrorMessage(status, detail) {
  if (status === 400 && /API key not valid/i.test(detail || '')) return 'That Gemini key was not accepted.';
  if (status === 401 || status === 403) return 'That Gemini key was not accepted.';
  if (status === 429) return 'Gemini is rate-limiting — try again shortly.';
  if (status >= 500) return 'Google had a problem (' + status + ').';
  return 'Gemini said no (' + status + ')' + (detail ? ': ' + detail.slice(0, 120) : '');
}

function newCode() {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
};

/* ---------- board (Kanban cards), one card list per pairing code ---------- */

async function loadBoard(env, code) {
  const raw = await env.PUSH_KV.get(boardKey(code));
  return raw ? JSON.parse(raw) : [];
}

async function saveBoard(env, code, cards) {
  await env.PUSH_KV.put(boardKey(code), JSON.stringify(cards));
}

/* ---------- custom board tabs, added by name from outside Nudge ----------
   Mirrors server.js's copy of this — the built-in four (BOARDS above) are
   fixed; this is for a tab added by something else entirely (a Google
   Sheet's Apps Script trigger POSTing to /api/boards is the case
   README.md walks through), one list per pairing code in its own KV key
   rather than folded into the card-list shape at boardKey(). */

async function loadCustomBoards(env, code) {
  const raw = await env.PUSH_KV.get(customBoardsKey(code));
  return raw ? JSON.parse(raw) : [];
}

async function saveCustomBoards(env, code, list) {
  await env.PUSH_KV.put(customBoardsKey(code), JSON.stringify(list));
}

function slugifyBoardName(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24);
}

async function allBoardIds(env, code) {
  return BOARDS.concat((await loadCustomBoards(env, code)).map((b) => b.id));
}

async function addCard(env, code, patch) {
  const cards = await loadBoard(env, code);
  const validBoards = await allBoardIds(env, code);
  const now = Date.now();
  const card = {
    id: crypto.randomUUID(),
    title: (patch.title || '').slice(0, 200) || 'Untitled',
    body: (patch.body || '').slice(0, 4000),
    url: patch.url || '',
    context: (patch.context || '').slice(0, 200),
    due: (patch.due || '').slice(0, 40),
    /* the raw due date + completion flag, kept alongside the pre-formatted
       `due` label above so "3 days overdue" can be recomputed fresh on
       every render instead of freezing at whatever it said the moment the
       card was filed */
    dueAt: (patch.dueAt || '').slice(0, 40),
    dueComplete: !!patch.dueComplete,
    cardId: (patch.cardId || '').slice(0, 60),
    /* the id of the Trello notification this card came from, if any — set
       once at filing time so the board can later tell Trello (and so the
       extension's popup) that mention has been dealt with */
    notifId: (patch.notifId || '').slice(0, 60),
    actorUser: (patch.actorUser || '').slice(0, 60),
    column: COLUMNS.includes(patch.column) ? patch.column : 'inbox',
    board: validBoards.includes(patch.board) ? patch.board : 'main',
    createdAt: now,
    updatedAt: now
  };
  cards.unshift(card);
  await saveBoard(env, code, cards);
  return card;
}

/* Delivers via web-push's own encryption (RFC 8291 aes128gcm) and VAPID JWT,
   but does the actual HTTP request with fetch() rather than web-push's
   built-in Node https client, since only fetch is guaranteed in Workers. */
async function sendPush(env, subscription, payload) {
  webPush.setVapidDetails(
    env.VAPID_SUBJECT || 'mailto:you@example.com',
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY
  );
  const req = webPush.generateRequestDetails(subscription, JSON.stringify(payload), { TTL: 60 });
  return fetch(req.endpoint, { method: req.method, headers: req.headers, body: req.body });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === '/api/vapid-public-key' && request.method === 'GET') {
      return json({ publicKey: env.VAPID_PUBLIC_KEY });
    }

    if (url.pathname === '/api/register' && request.method === 'POST') {
      const payload = await request.json().catch(() => ({}));
      const subscription = payload.subscription;
      if (!subscription || !subscription.endpoint) {
        return json({ ok: false, error: 'Missing subscription.' }, 400);
      }
      const code = newCode();
      await env.PUSH_KV.put(code, JSON.stringify({ subscription: subscription, createdAt: Date.now() }));
      return json({ ok: true, code: code });
    }

    if (url.pathname === '/api/unpair' && request.method === 'POST') {
      const payload = await request.json().catch(() => ({}));
      const code = String(payload.code || '').toUpperCase();
      if (code) await env.PUSH_KV.delete(code);
      return json({ ok: true });
    }

    if (url.pathname === '/api/notify' && request.method === 'POST') {
      const payload = await request.json().catch(() => ({}));
      const code = String(payload.code || '').toUpperCase();
      const title = payload.title || 'Nudge';
      const body = payload.body || '';
      const pushUrl = payload.url || '';
      if (!code) return json({ ok: false, error: 'Missing pairing code.' }, 400);

      const raw = await env.PUSH_KV.get(code);
      if (!raw) return json({ ok: false, error: 'Unknown pairing code.' }, 404);
      const entry = JSON.parse(raw);

      try {
        const res = await sendPush(env, entry.subscription, { title: title, body: body, url: pushUrl });
        if (res.status === 404 || res.status === 410) {
          await env.PUSH_KV.delete(code);
          return json({ ok: false, error: 'That phone unsubscribed or the pairing expired — pair again.' }, 410);
        }
        if (!res.ok) return json({ ok: false, error: 'Push service refused (' + res.status + ').' }, 502);
        return json({ ok: true });
      } catch (e) {
        return json({ ok: false, error: String((e && e.message) || e) }, 502);
      }
    }

    if (url.pathname === '/api/cards' && request.method === 'GET') {
      const code = String(url.searchParams.get('code') || '').toUpperCase();
      if (!code) return json({ ok: false, error: 'Missing code.' }, 400);
      return json({ ok: true, cards: await loadBoard(env, code), customBoards: await loadCustomBoards(env, code) });
    }

    /* Lets something outside Nudge add a board tab by name — a Google
       Sheet's Apps Script trigger POSTing here on every new row is the
       case README.md walks through ("Add a board from a Google Sheet"),
       so a new tab shows up on that code's board without anyone touching
       the extension or this Worker by hand. The pairing code is the only
       credential this needs, same as every other endpoint here — anyone
       who already has it can already read and write that code's cards.
       Upserts by slug, so sending the same name again (a trigger
       re-firing, a row edited back to what it was) relabels the existing
       tab instead of duplicating it. */
    if (url.pathname === '/api/boards' && request.method === 'POST') {
      const payload = await request.json().catch(() => ({}));
      const code = String(payload.code || '').toUpperCase();
      if (!code) return json({ ok: false, error: 'Missing code.' }, 400);
      const name = String(payload.name || '').trim().slice(0, 60);
      if (!name) return json({ ok: false, error: 'Missing board name.' }, 400);
      const id = slugifyBoardName(name);
      if (!id) return json({ ok: false, error: 'That name has no letters or numbers to build a board id from.' }, 400);
      if (BOARDS.includes(id)) return json({ ok: false, error: 'That name collides with a built-in board.' }, 400);

      /* This route was throwing an uncaught exception in production —
         surfacing as Cloudflare's own generic "Worker threw exception"
         error page, with the real cause invisible to both the caller (a
         Google Apps Script trigger, in practice) and to us. Wrapped like
         every other KV-touching route below so a failure at least comes
         back as a readable error instead of a blank crash page. */
      try {
        const list = await loadCustomBoards(env, code);
        const existing = list.find((b) => b.id === id);
        if (existing) {
          existing.label = name;
        } else {
          if (list.length >= MAX_CUSTOM_BOARDS) {
            return json({ ok: false, error: 'Already at the limit of ' + MAX_CUSTOM_BOARDS + ' custom boards for this code.' }, 400);
          }
          list.push({ id: id, label: name, addedAt: Date.now() });
        }
        await saveCustomBoards(env, code, list);
        return json({ ok: true, board: { id: id, label: name } });
      } catch (e) {
        return json({ ok: false, error: String((e && e.message) || e) }, 500);
      }
    }

    /* Read-only mirror of the extension's fetchCardWhole() (common.js) —
       same fields, same shape, just fetched with a worker-secret key+token
       over Trello's public API instead of injected into an open, logged-in
       Trello tab, since this page has no tab to inject into. Never touches
       anything write-side: TRELLO_TOKEN only ever needs read scope here. */
    if (url.pathname === '/api/trello-card' && request.method === 'GET') {
      if (!env.TRELLO_API_KEY || !env.TRELLO_TOKEN) {
        return json({
          ok: false,
          error: 'This server has no Trello credentials set up yet (TRELLO_API_KEY / TRELLO_TOKEN) — see mobile-push/README.md.'
        }, 501);
      }
      const cardId = String(url.searchParams.get('cardId') || '');
      if (!cardId) return json({ ok: false, error: 'Missing cardId.' }, 400);

      try {
        const trelloUrl = 'https://api.trello.com/1/cards/' + encodeURIComponent(cardId) +
          '?fields=name' +
          '&actions=commentCard&actions_limit=1000&action_memberCreator_fields=username,fullName' +
          '&key=' + encodeURIComponent(env.TRELLO_API_KEY) + '&token=' + encodeURIComponent(env.TRELLO_TOKEN);
        const r = await fetch(trelloUrl);
        if (!r.ok) return json({ ok: false, error: 'Trello said no (' + r.status + ').' }, r.status);
        const j = await r.json();

        const comments = (Array.isArray(j.actions) ? j.actions : [])
          .filter((a) => a && a.type === 'commentCard')
          .map((a) => ({
            at: Date.parse((a && a.date) || '') || 0,
            by: ((a && a.memberCreator && a.memberCreator.username) || '').toLowerCase(),
            byName: (a && a.memberCreator && a.memberCreator.fullName) || '',
            text: String((a && a.data && a.data.text) || '').replace(/\s+/g, ' ').trim()
          }));

        return json({ ok: true, comments: comments });
      } catch (e) {
        return json({ ok: false, error: String((e && e.message) || e) }, 502);
      }
    }

    /* The shareable board's own "Ask the board" — same idea as the
       extension's (common.js, askGeminiAboutBoard), just run here since
       this page has no Gemini key of its own to hold. Builds the context
       itself from this code's stored cards rather than trusting whatever
       the client sends, so the grounding always matches what's actually
       on the board. */
    if (url.pathname === '/api/ask' && request.method === 'POST') {
      if (!env.GEMINI_API_KEY) {
        return json({
          ok: false,
          error: 'This server has no Gemini key set up yet (GEMINI_API_KEY) — see mobile-push/README.md.'
        }, 501);
      }
      const payload = await request.json().catch(() => ({}));
      const code = String(payload.code || '').toUpperCase();
      if (!code) return json({ ok: false, error: 'Missing code.' }, 400);
      const question = String(payload.question || '').trim();
      if (!question) return json({ ok: false, error: 'Missing question.' }, 400);
      const history = Array.isArray(payload.history) ? payload.history : [];
      const cardId = String(payload.cardId || '');

      const board = await loadBoard(env, code);
      const focusCard = cardId ? board.find((c) => c.id === cardId) : null;
      let context;
      if (focusCard) {
        context = buildSingleCardContext(focusCard);
      } else {
        const boardLabels = Object.assign({}, BOARD_LABELS);
        (await loadCustomBoards(env, code)).forEach((b) => { boardLabels[b.id] = b.label; });
        context = buildBoardChatContext(board, boardLabels);
      }
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
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
            body: JSON.stringify({
              system_instruction: { parts: [{ text: BOARD_CHAT_SYSTEM }] },
              contents: contents,
              /* Flash's default "thinking" tokens count against
                 maxOutputTokens — without turning that off, the model can
                 spend most or all of the budget reasoning silently and get
                 cut off mid-sentence before finishing the actual answer.
                 thinkingBudget: 0 stops that; this is a grounded lookup,
                 not a task that benefits from chain-of-thought. Budget
                 itself raised too, since a real answer covering several
                 cards runs longer than 800 tokens allowed for even with
                 thinking off. */
              generationConfig: { temperature: 0.2, maxOutputTokens: 2000, thinkingConfig: { thinkingBudget: 0 } }
            })
          }
        );
        if (!r.ok) {
          let detail = '';
          try { const b = await r.json(); detail = (b && b.error && b.error.message) || ''; } catch (e) {}
          return json({ ok: false, error: geminiErrorMessage(r.status, detail) }, r.status);
        }
        const body = await r.json();
        const parts = (((body.candidates || [])[0] || {}).content || {}).parts || [];
        const answer = parts.map((p) => p.text || '').join('').trim();
        return json({ ok: true, answer: answer || '(no answer)' });
      } catch (e) {
        return json({ ok: false, error: 'Could not reach Gemini: ' + String((e && e.message) || e) }, 502);
      }
    }

    if (url.pathname === '/api/cards' && request.method === 'POST') {
      const payload = await request.json().catch(() => ({}));
      const code = String(payload.code || '').toUpperCase();
      if (!code) return json({ ok: false, error: 'Missing code.' }, 400);
      const card = await addCard(env, code, payload);
      return json({ ok: true, card: card });
    }

    const cardMatch = url.pathname.match(/^\/api\/cards\/([^/]+)$/);
    if (cardMatch && request.method === 'PATCH') {
      const payload = await request.json().catch(() => ({}));
      const code = String(payload.code || '').toUpperCase();
      if (!code) return json({ ok: false, error: 'Missing code.' }, 400);
      if (payload.column !== undefined && !COLUMNS.includes(payload.column)) {
        return json({ ok: false, error: 'Invalid column.' }, 400);
      }
      if (payload.board !== undefined && !(await allBoardIds(env, code)).includes(payload.board)) {
        return json({ ok: false, error: 'Invalid board.' }, 400);
      }

      const cards = await loadBoard(env, code);
      const card = cards.find((c) => c.id === cardMatch[1]);
      if (!card) return json({ ok: false, error: 'Unknown card.' }, 404);

      /* only touches fields actually present in the request — e.g. a backfill
         pass sends {context, due, cardId} without column, a drag/drop sends
         {column} alone */
      if (payload.column !== undefined) card.column = payload.column;
      if (payload.board !== undefined) card.board = payload.board;
      if (payload.title !== undefined) card.title = String(payload.title).slice(0, 200) || 'Untitled';
      if (payload.body !== undefined) card.body = String(payload.body).slice(0, 4000);
      if (payload.context !== undefined) card.context = String(payload.context).slice(0, 200);
      if (payload.due !== undefined) card.due = String(payload.due).slice(0, 40);
      if (payload.dueAt !== undefined) card.dueAt = String(payload.dueAt).slice(0, 40);
      if (payload.dueComplete !== undefined) card.dueComplete = !!payload.dueComplete;
      if (payload.cardId !== undefined) card.cardId = String(payload.cardId).slice(0, 60);
      if (payload.notifId !== undefined) card.notifId = String(payload.notifId).slice(0, 60);
      if (payload.actorUser !== undefined) card.actorUser = String(payload.actorUser).slice(0, 60);
      if (payload.comments !== undefined) {
        const c = sanitizeComments(payload.comments);
        if (c) { card.comments = c; card.commentsAt = Date.now(); }
      }
      card.updatedAt = Date.now();
      await saveBoard(env, code, cards);
      return json({ ok: true, card: card });
    }

    if (cardMatch && request.method === 'DELETE') {
      const payload = await request.json().catch(() => ({}));
      const code = String(payload.code || '').toUpperCase();
      if (!code) return json({ ok: false, error: 'Missing code.' }, 400);

      const cards = await loadBoard(env, code);
      await saveBoard(env, code, cards.filter((c) => c.id !== cardMatch[1]));
      return json({ ok: true });
    }

    return env.ASSETS.fetch(request);
  }
};
