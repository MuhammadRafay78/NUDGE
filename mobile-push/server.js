require('dotenv').config();
const express = require('express');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'subscriptions.json');

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

app.listen(PORT, () => {
  console.log('Nudge mobile push server listening on port ' + PORT);
});
