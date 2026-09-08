# Nudge mobile push

Relays the extension's tag / follow-up / "more waiting" notifications to a phone
over [Web Push](https://developer.mozilla.org/en-US/docs/Web/API/Push_API), since a
browser extension has no way to reach a device directly. Two pieces:

- **A server** that holds nothing but push subscriptions, keyed by a random
  pairing code. `POST /api/notify` is what the extension calls. Two interchangeable
  backends live in this repo — pick one:
  - `server.js` (this directory) — plain Node/Express, run it yourself anywhere.
  - `worker/` — the same API on Cloudflare Workers, no server to babysit.
- **A pairing page** (`public/`, shared by both backends) — a PWA you open on
  your phone once, add to your Home Screen, and it hands you an 8-character
  pairing code.

## iOS requirement — read this first

iOS only delivers Web Push to a page that has been **added to the Home Screen**
(Settings → Share → *Add to Home Screen*), on iOS 16.4+. A push subscription
created from a normal Safari tab will not receive anything. The pairing page
enforces this — it won't offer the "Enable notifications" button until you're
running it from the Home Screen icon.

## Option A — Node/Express, self-hosted

### 1. Set up

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

### 2. Run it

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

## Option B — Cloudflare Workers

`worker/` is the same API (`/api/vapid-public-key`, `/api/register`, `/api/notify`,
`/api/unpair`) and the same pairing page, running as a Cloudflare Worker instead
of an Express server — no box to keep running, no `subscriptions.json` file (it
uses Workers KV instead). It uses the real [`web-push`](https://www.npmjs.com/package/web-push)
npm package for the actual encryption/VAPID signing (correct RFC 8291 `aes128gcm`,
same as Option A) via Workers' `node:crypto` support, and only swaps out the final
delivery step for `fetch()` since Workers doesn't ship `web-push`'s Node HTTP client.

### 1. KV namespace

`wrangler.toml` already points at a KV namespace (`nudge-mobile-push`,
id `133acdb9e60b40b29521ca4ed29de7b9`) created ahead of time. If that's not
your Cloudflare account, or you'd rather use your own, create your own and
swap the `id` in `wrangler.toml`'s `[[kv_namespaces]]` block:

```bash
cd mobile-push/worker
npm install
npx wrangler login                      # once, opens a browser
npx wrangler kv namespace create nudge-mobile-push
```

### 2. Generate VAPID keys and set them as secrets

```bash
npm run generate-vapid                  # prints a key pair (same format as Option A)
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT    # a mailto: address or https:// URL
```

### 3. Deploy

```bash
npx wrangler deploy
```

Wrangler prints the `*.workers.dev` HTTPS URL — that's what you open on the
phone and paste into the extension's Settings.

### Local testing before you deploy

```bash
cd mobile-push/worker
cat > .dev.vars <<'EOF'
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@example.com
EOF
npx wrangler dev --local
```

`--local` runs entirely against a local KV emulation — nothing touches your
real Cloudflare account until you `wrangler deploy`. `.dev.vars` is
git-ignored; never commit real keys to it.

## Pair your phone

1. Open your server's HTTPS URL in Safari on the iPhone (from Option A's
   hosting URL, or the `*.workers.dev` URL Option B's `wrangler deploy` printed).
2. Share → **Add to Home Screen**.
3. Open **Nudge** from the Home Screen icon (not from Safari).
4. Tap **Enable notifications** and allow the permission prompt.
5. It shows an 8-character pairing code — that's the phone's, permanent
   until you unpair.

## Point the extension at it

In the extension: **Settings → Mobile notifications**
- Server address: your deployed server's HTTPS URL
- Pairing code: the code from pairing your phone, above
- Turn on **"Also notify my phone"**
- **Send a test one** to confirm the round trip

From then on, every tag notification, the "N more tags waiting" summary, and
the weekly follow-up reminder are pushed to the phone alongside the desktop
notification — tapping one opens the card, same as on desktop.

## Kanban board

Every successful push also drops a card into an **Inbox** column on a small
Kanban board — same server, same pairing code, so the extension's board
(**popup/side panel → Board**, or Settings → Mobile notifications → Open
board) and the phone's board (open the pairing page → **Open board**) show
the same cards. Columns are fixed: **Inbox → Doing → Done** on every board
except Action Items, which gets two more — **Inbox → Doing → Awaiting
client → Awaiting team → Done** — for a client ask that's blocked on
someone else's reply, split by who it's waiting on.
Cards are also grouped onto boards — **Main / QTM / Tax Plan Draft / Action
Items** — picked automatically when a card is filed; anything that itself
reads as an action-/pending-items list lands on the Action Items board
rather than a same-named column, so that grouping only happens once.
Switch between boards with the tabs above the columns. Move a card with
its dropdowns, or drag it — onto another column, or straight onto a
different board's tab.
The sort control next to search reorders cards within each column, by due
date (soonest and overdue first) or by when they were added (newest first).
Type into "Start a card…" to add one by hand (lands straight in Doing) for
something you're working on that didn't come from a notification.

The board needs nothing beyond what pairing already set up — no extra
config — but it does require Settings → Mobile notifications to have a
server address and pairing code filled in, even if the phone-push toggle
itself is off.

### Sharing the board with another laptop (or any browser)

`board.html` also accepts the pairing code as a `?code=` URL parameter,
so it doesn't need the phone's full install/notification-permission flow
to be viewed elsewhere — Settings → Mobile notifications → **Copy board
link** builds `<server>/board.html?code=<code>` and copies it. Open that
link in any browser and it shows the same board immediately; the code is
remembered there afterward, so the plain `/board.html` link keeps working
on that device too.

### Trello comments on the shareable board

By default, a card opened from that link only shows the one snippet
Nudge stored on it when it was filed — this page has no Trello session of
its own (it isn't the extension, so it can't read trello.com's cookies),
so there's nothing more it can fetch on its own.

The extension does have a Trello session, though, so it does this syncing
itself, automatically, in two ways — no Trello API key needed for either:

- **Every fresh tag**: the moment the extension notices you've been
  tagged and files the card, it also fetches that card's comment thread
  (using whichever Trello tab happens to already be open — same
  best-effort lookup the card's due date already gets) and hands a copy to
  the server right then, before you've done anything at all.
- **Opening a card**: the extension's own **Open card** panel (popup/side
  panel → Board) always fetches the live thread when you open a card
  there, and re-syncs it to the server every time, so it stays current.

Between the two, most cards are covered without you doing anything. For
one filed before this existed, or tagged with no Trello tab open at the
time, **Backfill details** (the button next to Recategorize on the
extension's board) also syncs a comment thread for any card that doesn't
have one yet, alongside the client-name/due-date backfill it already did.

The one gap neither covers: a card nobody's opened in the extension and
that was tagged with no Trello tab open, before you've had a chance to
click Backfill. For that case (or to skip needing the extension open at
all), setting `TRELLO_API_KEY` / `TRELLO_TOKEN` lets the *server* fetch a
card's comment thread directly instead:

1. Get an API key at [trello.com/app-key](https://trello.com/app-key)
   (while logged into Trello) — that page also shows your key.
2. Generate a **read-only** token by visiting (with that key filled in):
   `https://trello.com/1/authorize?expiration=never&scope=read&response_type=token&key=YOUR_KEY&name=Nudge`
   — click **Allow**, and it shows the token on the next page.
3. Set both as `TRELLO_API_KEY` / `TRELLO_TOKEN` — in `.env` for Option A,
   or `npx wrangler secret put TRELLO_API_KEY` / `TRELLO_TOKEN` for Option B.

`scope=read` means this token can only ever read — it can't post a
comment, react, or move a card, on this or anything else in your Trello
account. Leave both unset to skip this entirely — the board still shows
whatever the extension has already synced, and otherwise falls back to
the stored snippet, same as before either of these existed.

### Ask the board

Both boards have a floating **💬** button, pinned to the bottom-right
corner so it stays reachable while scrolling — tap it to open a chat
grounded only in the cards actually on the board (title, due date,
board/column, and any synced comment thread), not a general assistant. It
won't answer anything the board data doesn't already say.

Opening any card also shows an **💬 Ask about this card** button right in
its header — a shortcut that opens the same chat with the question box
already pointed at that card by name, for when what you want to ask is
about one specific card rather than the board in general.

On the extension's board this reuses the same Gemini key as **Settings →
Sort mentions** — nothing extra to set up if you already use that. On the
shareable board it's a separate piece: this page has no key of its own to
hold, so the server needs `GEMINI_API_KEY` set for its **Ask the board**
button to work:

1. Get a free key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
2. Set it as `GEMINI_API_KEY` — in `.env` for Option A, or
   `npx wrangler secret put GEMINI_API_KEY` for Option B.

Leave it unset to skip this on the shareable board — its Ask button just
says the server isn't set up for it yet; the extension's own Ask button is
unaffected either way, since it never goes through this server at all.

## API

| Route | Body | Does |
|---|---|---|
| `GET /api/vapid-public-key` | — | Public key the pairing page subscribes with |
| `POST /api/register` | `{ subscription }` | Stores a `PushSubscription`, returns `{ code }` |
| `POST /api/notify` | `{ code, title, body, url }` | Sends a push to that code's phone, and files a card in Inbox |
| `POST /api/unpair` | `{ code }` | Forgets that phone |
| `GET /api/cards?code=` | — | Lists that code's board cards |
| `POST /api/cards` | `{ code, title, body?, url?, column? }` | Adds a card (defaults to Inbox) |
| `PATCH /api/cards/:id` | `{ code, ...fields }` | Updates any subset of a card's fields — `column` (`inbox`\|`doing`\|`waiting`\|`done` — `waiting` only shown on the Action Items board), `board`, or others including `comments` (the extension syncing a card's Trello thread) |
| `DELETE /api/cards/:id` | `{ code }` | Removes a card |
| `GET /api/trello-card?cardId=` | — | A card's full comment thread from Trello — 501 if `TRELLO_API_KEY`/`TRELLO_TOKEN` aren't set |
| `POST /api/ask` | `{ code, question, history? }` | Answers a question grounded in that code's board cards — 501 if `GEMINI_API_KEY` isn't set |

`code` is an 8-character pairing secret (`newCode()` in `server.js`) — anyone
who has it can push notifications to that phone, so treat it like a password
and don't post it anywhere public.
