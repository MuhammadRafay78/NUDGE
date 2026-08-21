import webPush from 'web-push';

/* excludes 0/O/1/I/L so a code read aloud or copied by hand isn't ambiguous */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;

const COLUMNS = ['inbox', 'doing', 'action', 'done'];
const BOARDS = ['main', 'qtm', 'taxplan'];
const boardKey = (code) => 'board:' + code;

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

async function addCard(env, code, patch) {
  const cards = await loadBoard(env, code);
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
    board: BOARDS.includes(patch.board) ? patch.board : 'main',
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
      return json({ ok: true, cards: await loadBoard(env, code) });
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
      if (payload.board !== undefined && !BOARDS.includes(payload.board)) {
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
      if (payload.context !== undefined) card.context = String(payload.context).slice(0, 200);
      if (payload.due !== undefined) card.due = String(payload.due).slice(0, 40);
      if (payload.dueAt !== undefined) card.dueAt = String(payload.dueAt).slice(0, 40);
      if (payload.dueComplete !== undefined) card.dueComplete = !!payload.dueComplete;
      if (payload.cardId !== undefined) card.cardId = String(payload.cardId).slice(0, 60);
      if (payload.actorUser !== undefined) card.actorUser = String(payload.actorUser).slice(0, 60);
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
