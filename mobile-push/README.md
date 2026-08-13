# Nudge mobile push

Relays the extension's tag / follow-up / "more waiting" notifications to a phone
over [Web Push](https://developer.mozilla.org/en-US/docs/Web/API/Push_API), since a
browser extension has no way to reach a device directly. Two pieces:

- **This server** — a small Express app. It holds nothing but push subscriptions,
  keyed by a random pairing code. `POST /api/notify` is what the extension calls.
- **A pairing page** (`public/`) — a PWA you open on your phone once, add to your
  Home Screen, and it hands you an 8-character pairing code.

## iOS requirement — read this first

iOS only delivers Web Push to a page that has been **added to the Home Screen**
(Settings → Share → *Add to Home Screen*), on iOS 16.4+. A push subscription
created from a normal Safari tab will not receive anything. The pairing page
enforces this — it won't offer the "Enable notifications" button until you're
running it from the Home Screen icon.

## 1. Set up

```bash
cd mobile-push
npm install
npm run generate-vapid        # prints a VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY pair
cp .env.example .env           # then paste the generated keys into .env
```

`VAPID_SUBJECT` in `.env` should be a `mailto:` address or an `https://` URL —
push services use it to contact you if something's misbehaving. Generate the
keys once and keep them; if you regenerate them, every already-paired phone
has to re-pair.

## 2. Run it

```bash
npm start
```

Locally that's `http://localhost:3000`, which is fine for testing on a
desktop browser but **iOS needs a real HTTPS address** it can reach — it
won't accept a plain-HTTP or localhost origin as a push-capable PWA. Deploy
it somewhere with HTTPS, e.g.:

- **Render / Railway / Fly.io** — connect this `mobile-push/` folder as the
  app root, set `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` as
  environment variables (don't commit `.env`), build command `npm install`,
  start command `npm start`.
- **Your own box** — run `npm start` behind any reverse proxy that terminates
  TLS (nginx, Caddy, Cloudflare Tunnel).

Subscriptions are stored in `subscriptions.json` next to `server.js`. That's
fine for personal use (a handful of paired phones); it's flat-file storage,
not a database, so plan accordingly if this ever needs to scale past that.

## 3. Pair your phone

1. Open the server's URL in Safari on the iPhone.
2. Share → **Add to Home Screen**.
3. Open **Nudge** from the Home Screen icon (not from Safari).
4. Tap **Enable notifications** and allow the permission prompt.
5. It shows an 8-character pairing code — that's the phone's, permanent
   until you unpair.

## 4. Point the extension at it

In the extension: **Settings → Mobile notifications**
- Server address: the HTTPS URL from step 2 above
- Pairing code: the code from step 3
- Turn on **"Also notify my phone"**
- **Send a test one** to confirm the round trip

From then on, every tag notification, the "N more tags waiting" summary, and
the weekly follow-up reminder are pushed to the phone alongside the desktop
notification — tapping one opens the card, same as on desktop.

## API

| Route | Body | Does |
|---|---|---|
| `GET /api/vapid-public-key` | — | Public key the pairing page subscribes with |
| `POST /api/register` | `{ subscription }` | Stores a `PushSubscription`, returns `{ code }` |
| `POST /api/notify` | `{ code, title, body, url }` | Sends a push to that code's phone |
| `POST /api/unpair` | `{ code }` | Forgets that phone |

`code` is an 8-character pairing secret (`newCode()` in `server.js`) — anyone
who has it can push notifications to that phone, so treat it like a password
and don't post it anywhere public.
