# Nudge

Two jobs, one question: **is this client ready, and who needs to know?**

1. **Who tagged you on Trello** — one mention at a time, replies in place, dismissed when you've dealt with it.
2. **The weekly follow-up** — reads next week's QTM meetings off Dwight's calendar, matches each to its Trello card, reads that card's comments to work out what is genuinely still outstanding, and drafts one comment per card tagging Paul.

### Two things it refuses to do

**Ask twice.** Before drafting anything it reads the card's own comments. If you already tagged Paul there today, the card arrives unticked and says so — *"⏸ Already asked @pauleleazar1 on this card 2h ago — unticked so it is not asked twice."* It's a default, not a lock; tick it if you mean it. The window is configurable (today / 2 days / 3 days / a week / never skip).

**Repeat the same four bullets every week.** The card's own comments are the record: Paul writes what he chased and what came back, so they're read to work out where each document actually stands. A document the comments say is in is dropped; one that's been asked for twice says so; one the client promised says that instead. This costs nothing extra — they're the same comments already read for the guard above.

> @pauleleazar1 Could you follow up with the client for:
>
> - Tax Plan Organizer (the questionnaire) — asked twice already, last on 24 Jul, still nothing
> - Year-to-date financials (P&L and balance sheet) — they said they would send it (28 Jul)
>
> Already noted on this card: Year-to-date paystubs, Last year's tax return (24 Jul).

Sentences are split before they're read, so *"Paystubs are in, still no organizer"* credits the paystubs and keeps chasing the organizer. Negations are respected: *"has not been uploaded"* is not read as uploaded. When every remaining document has been chased before, the opener changes from *"Could you follow up"* to *"Still outstanding after chasing"* — because by then that's the actual news.

## Install (2 minutes)

1. Unzip this folder somewhere permanent (e.g. `~/Documents/nudge`).
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `nudge` folder.
4. Pin the icon to your toolbar.

## How it works

- **Questions** are saved lookups, each scoped to sites. When you open the popup or side panel, every question whose site pattern matches the current URL runs against the page.
- A question matches on any combination of: **people/names**, **keywords/phrases**, **regex**, and **built-in patterns** (documents & file links, @mentions, assignment language, message/sender language, dates, times, deadlines, money).
- By default a question matches if *any* criterion hits (OR). Tick **Require every criterion** for AND — e.g. "text mentions Rafay **and** has assignment language" = tasks assigned to you.
- **Avatar matching:** on board apps the assignee is often just a coloured circle with initials — the name only exists in a `title`/`aria-label` attribute. The **My avatar initials** field matches that circle exactly, per card, so a stray letter R in body text never counts. Use **Who's on this page?** in the popup to see the exact tokens a page exposes (click a chip to copy it).
- **New detection / inbox behaviour:** the first time you check a page, everything is marked new. Click an item to mark it **handled** and it drops out of the list; **Undo** brings it back, **Show all** shows the history. Only items that weren't there before are flagged `NEW` (orange row + badge count). Snapshots are stored per question per URL path.
- The toolbar icon shows a **badge count of new items** as you browse, so you don't have to open anything to know something changed. Turn it off in Manage questions.
- Click any result to **jump to it on the page** (it scrolls there and outlines it).

## Set up for Trello

Out of the box one question is on: **Who tagged me in a comment?** Everything else (Gmail, Slack, Drive, Calendar) is switched off — enable them later in Manage questions if you want.

One **Filter** button sits under the header. It shows what's currently on — `Today`, or `Today · QTM` — with a dot when you're off the defaults. Click it and a small panel opens with two sections; picking anything closes it again. Clicking outside or pressing Escape also closes it.

**When** — `Today` (the default) · `Yesterday` · `Last 7 days`. Yesterday means strictly yesterday, so it's a clean way to catch up on what you missed.

**Board** — `All` · `QTM` · `TPD` · `TPR`, each showing how many are waiting:

| Chip | Catches |
|---|---|
| QTM | `QTM`, `QTM1`, `QTM2`, `QTM3`… (also `UTM`, in case of a typo) |
| TPD | `TPD`, `TPD1`… |
| TPR | `TPR`, `TPR1`… |

Matched against the card name, the list and the board, so `[QTM2] Gary Warner` lands in QTM however your boards are organised.

They stack, so `QTM` + `Today` shows only today's QTM tags, and **Reset** puts both back. When a filter is why the list is empty, it says so — *"Nothing new in QTM — 1 waiting under All"* — rather than looking broken.

**No Trello tab needed (usually).** Notifications and the panel both try three routes in order: the Trello tab you're looking at, any other Trello tab you have open, then straight from the extension with your existing cookies — which needs no tab at all. Whether that last one works depends on how Trello marks its session cookie, so it's attempted rather than assumed; if Trello refuses, you're told *"Trello would not answer without a tab open — open Trello once and leave it open"* rather than shown an empty list.

**Open card doesn't reload anything.** It focuses your Trello tab and opens the card the way clicking it does: if the card is on the board in front of you it clicks the real link; otherwise it pushes the URL through Trello's own router. Then it checks the card actually opened, and only falls back to a real page load if the router quietly did nothing.

**It updates itself.** You never press refresh: the background nudges the panel the moment a new tag lands, there's an 8-second tick behind that, and it re-checks whenever you focus the window. If a refresh happens while you're reading, it keeps you on the card you're on instead of jumping to the top.

Each row shows its own age (`1h ago`, `5h ago`), read from Trello's timestamp on that notification. On a page with no timestamps at all — a board view, say — the date filter can't apply, so it shows everything and says so rather than silently hiding your results.

## Replying without leaving the panel

The composer **opens already tagging them back** — `@peleazar ` — because a Trello reply without a mention often goes unread. Type `@` anywhere and a picker appears: arrow keys or mouse to choose, Tab or Enter to insert, Escape to dismiss. It knows your board members (fetched quietly when the composer opens) plus everyone who has tagged you recently. While the picker is open, Enter inserts the handle rather than sending, so you cannot fire off a half-typed mention.

**Reacting instead of replying.** Four emoji sit above the buttons — 👍 Got it · ✅ Done · 👀 Looking at it · 🙏 Thanks. Often that's the honest answer: *"let us know once the prep notes are updated"* wants a 👍, not a paragraph. Clicking one posts a real Trello reaction on that comment and marks the mention handled, same as a reply would.

Mechanically it has to find the comment first: Trello hangs reactions off the comment itself, and a notification doesn't carry that id, so the card's comments are matched on text and author. If the panel truncated a long comment, the shorter of the two is compared. If it can't find it, it says so rather than reacting to the wrong comment.

The **Reply** button opens a small composer on the mention itself. Type, press Enter (Shift+Enter for a new line), and it posts as a comment on that Trello card — no tab switch, no scrolling to the comment box. Four canned openers sit above the box (*Got it, thanks* / *Yes, already delivered* / *Will do today* / *Looking at it now*); clicking one fills the box but never sends on its own, so nothing goes out that you haven't looked at.

A successful reply marks the mention handled and moves you to the next one, which is usually the whole interaction.

If it fails — session expired, Trello tab needs a reload, no connection — it says so in the composer, **keeps your text** so you can retry, and does *not* mark the item done. It never claims to have sent something it didn't.

Mechanically it's the same trick as reading: the POST runs inside your Trello tab as the page, with the login you already have, including the `dsc` token Trello requires on writes. So this needs a Trello tab open, same as notifications do.


## Weekly follow-up drafts

Every Monday at 8:30 (configurable) it:

1. Reads **next week** from **Dwight's** calendar (`u/1` — switchable).
2. Keeps only the meetings whose title contains **QTM**. Everything else — dentist, standups, TPR meetings — is ignored outright.
3. Matches each kept meeting to its Trello card.
4. Pulls the documents still outstanding from that card's checklists.
5. Prepares **one comment per card** — because that's how the admin works: card by card, in the comments, not one summary message.

The review page lists a block per matched card:

```
☑  [QTM2] Gary Warner                        Tuesday 2–3pm
   2 outstanding: Quarterly Organizer, YTD Paystubs from the Business
   ┌──────────────────────────────────────────────────────────┐
   │ @pauleleazar1 Meeting Tuesday 2–3pm. Still outstanding:   │
   │ - Quarterly Organizer                                     │
   │ - YTD Paystubs from the Business                          │
   │                                                           │
   │ Could you follow up with the client and ask them to        │
   │ upload these before the meeting? Thanks!                   │
   └──────────────────────────────────────────────────────────┘
   [ Send this one ]   open card ↗

☐  [QTM3] Ufredo Barahona                    Wednesday 10am
   Nothing outstanding (29/29 done)
   …
```

- **Send all** posts each one to its own card, in sequence, with a short pause between. Or **Send this one** per card.
- **Only four things are ever chased.** A card's checklists hold 25+ items — prep notes, master data, QBO access, three years of returns, each repeated on several checklists. All of that is internal. The message asks for at most:

  - Tax Plan Organizer (the questionnaire)
  - Year-to-date paystubs
  - Year-to-date financials (P&L and balance sheet)
  - Last year's tax return (1120 / 1065 / 1040 as applicable)

  Duplicates collapse, older-year returns fold into "last year's", and everything else is counted but not chased — expandable on the page as *"10 other checklist items on this card"*. Which of the four to chase is a set of checkboxes in settings.
- A card whose only outstanding items are internal is **unticked**, and says so: *"Nothing outstanding from the client (3 internal checklist items left) — no follow-up needed."*
- Each message contains only that client's own missing documents — nothing about the other clients.
- Cards with nothing outstanding are **unticked by default**, since there's nothing to chase. Tick one to include it anyway.
- Every message is editable before it goes, and a posted card locks so you can't double-post.
- If one card fails mid-run, the rest still go, that card keeps its Send button, and the status says *"Posted 3 of 4 · 1 failed, still listed above."*
- **Only QTM meetings count.** The header tells you what it skipped: *"3 QTM meetings · 3 matched to a card · 4 other meetings ignored"*. If there are no QTM meetings at all it says so, with the ignored count, rather than looking broken.
- The code is a setting (`QTM`). Comma-separate for more than one (`QTM, TPR`), or clear it to consider every meeting.
- **How matching actually works.** Your calendar hands over several label shapes, and all of them are handled:

| Label | Read as |
|---|---|
| `[QTM1] Taylor Jackson and Dwight Martinez` | Taylor Jackson · QTM1 — the fullest form, preferred |
| `Warren QTM2 Dwight Martinez 2026Warren QTM211am` | Warren · QTM2 · 11am (doubled, time glued) |
| `11am To 12pm Mario QTM1` | Mario · QTM1 · 11am–12pm (time in front) |
| `Canceled: [TPD] Justin …` | skipped — cancelled meetings are never chased |
| `Read.ai Josh Dunning`, `Calendly booking …` | skipped — notetakers and booking links |
| `Block 5–7pm`, `Nestor X Dwight Internal` | skipped — no client, internal |

  Times, day names, `Dwight Martinez`, the year and `Google Meet` are all stripped out of the client name before matching, and Trello is searched on the **name alone** — codes and times only confuse its search.
- **Two events per client collapse into one comment.** Your week has both `[QTM1] Taylor Jackson …` and a short `Taylor QTM1`; they resolve to the same card, the fuller name wins, and the card is only ever commented on once.
- **Always ignore** is a setting: `read.ai, notetaker, meeting invite, booking, calendly, …`. Anything matching it is dropped before the QTM check.
- A **first name plus a matching code** is enough: `Warren QTM2` → `[QTM2] Warren Bowers`. But the code must agree — `Joe QTM2` will never land on `[QTM3] Joe Hendricks`.
- If **two cards fit equally well** (two `[QTM2] Deepak…` cards, say) it asks rather than guessing. The block shows both names plus *Neither*; nothing is drafted or posted until you pick.
- QTM meetings with no matching card are listed at the bottom and never posted anywhere.
- Matching needs at least two words in common between the event title and the card name, so a shared first name alone won't put a comment on the wrong client's card.
- **Reading the calendar** briefly opens a Google Calendar tab in the background, reads next week, and closes it. It **polls** for the grid rather than waiting a fixed few seconds, so it finishes as soon as the events appear — typically a second or so.
- **Speed.** Card lookups run four at a time rather than one by one, and once a client is matched to a card that mapping is **remembered for two months** — so later weeks skip the search entirely. A 13-meeting week takes roughly 3s cold and 2s warm. Document checklists are always read fresh, since that's the part that changes. If a remembered card stops answering it's forgotten and looked up again, rather than trusted forever.
- The header tells you how long it took: *"prepared just now in 2.4s (13 cards remembered)"*.
- Settings on that page: the admin's handle (`pauleleazar1`), **which Google account's calendar to read** — Rafay `u/0`, Dwight `u/1`, Justin `u/2`, defaulting to Dwight — which day and hour to prepare it, and an off switch. Reach it any time from **Weekly follow-up** in the panel.


## Canopy

Open the panel on any Canopy page and a **CANOPY** section appears at the top, reading whatever is in front of you:

```
CANOPY  Supply Chain Sherpas          Business
Folder  Tax Planning / Quarterly Tax Planning / Q2

2 FILES HERE
Joe Walsh_ Quarterly Tax Planning Organizer.pdf
7/30/2026 · Paul Eleazar Tuppal
Joseph Walsh - Master Data.docx
7/31/2026 · Muhammad Rafay (me)

📥 FILE INBOX: 2 WAITING TO BE FILED
IRS Submission Packet 05192026.pdf     5/20/2026 · Joe Walsh
Letter to Dwight.docx                  5/20/2026 · Joe Walsh

[ Copy list ]  [ Re-read ]  [ What can it see? ]
```

The **File Inbox** count is the part worth having — unfiled uploads are invisible unless you go looking, and a client document sitting there is the same as not having it.

It's read-only: it never changes anything in Canopy.

**How it finds things.** The file list is located by its own column headings — a table with *Name* and *Date added* is the file list, whatever Canopy calls its CSS classes. The client id comes from the URL, the folder path from the breadcrumb, and the inbox from leaf elements that look like filenames. An earlier version keyed off class names and broke; this one shouldn't. **What can it see?** dumps everything it found if a page reads oddly.

## What replaced the Canopy check

An earlier version read your open Canopy tab to see what the client had already uploaded, and searched your Gmail to count follow-ups already sent. Both were removed in v5.9: Canopy's pages carry no client name in their markup, the check needed the right tab open to be any use, and the card's own comments turn out to say more than either — for free, since they're already fetched.

So the single source is now the **card's comment history**, described at the top of this file.

## The Trello mentions workflow (the main one)

1. On any Trello page — board, card, anywhere — click the extension.
2. **Who tagged me in a comment?** lists only comments that tag you, each with a headline like *"Paul Eleazar tagged you in a comment on '[QTM3] Ufredo Barahona'"* and the comment text underneath.
3. Click a row → marked handled, **disappears from the list**. `open card →` navigates the *current* tab to that card (no new tabs) and marks it handled at once. In the side panel the list stays open beside the card, which is the nicer way to work through several.
4. Misclick? **Undo**. Want the history? **Show handled**.
5. When the admins post 15 more follow-ups to each other, none of it appears — only comments that tag you do. The toolbar badge counts just those.

## The questions it ships with

| Question | Runs on | Matches on |
|---|---|---|
| **Who tagged me in a comment?** | Trello (via Trello's own data), Jira, Asana, Linear, ClickUp | comments that tag `@rafay10` |
| Which cards am I on? | Trello, Jira, ClickUp, Linear | your **avatar initial (R)** on the card, or your name in its tooltip |
| Who messaged me? | Gmail, Slack, Teams, Outlook | your names + message/sender language + @mentions |
| What tasks are assigned to me? | Asana, Linear, Notion, Gmail | your name/avatar **AND** assignment language |
| Anything new assigned to or mentioning me? | every site | your names |
| Any new documents uploaded? | Drive, Dropbox, SharePoint, Box | file links + "uploaded/attachment/new file" |
| Anything on the calendar for a client? | Google Calendar | consult / call / meeting / review |
| Any deadlines mentioned? | every site (off by default) | deadline language + dates |

Edit any of them, or add your own, from **Manage questions**. A per-client question is the common one: name `Acme — anything new?`, sites `*`, people/names `Acme, Acme Corp, acme.com`.

## Site patterns

One per line, `*` is a wildcard:

```
calendar.google.com/*
drive.google.com/*
*.atlassian.net/*
*acmecorp*
*                      ← everywhere
```

## How Trello works now (v2)

Scraping the page was the wrong approach for Trello: a board page contains no comment text at all, only the count badges. So on any Trello page the extension now **asks Trello for your own mentions** instead of reading the screen.

It runs the same request Trello's own web app makes — `GET /1/members/me/notifications` — from inside your Trello tab, using the login you already have. That means:

- It works on a **board**, an **open card**, the **notifications page**, anywhere on trello.com.
- Results are exact, not guessed from text: who commented, which card, the full comment, the timestamp, and whether Trello still counts it unread.
- Only two notification types count as "tagged me": `mentionedOnCard`, and `commentCard` where the comment body contains your handle. Being **added to** a card is membership, not a tag, and is excluded.
- Handled state is keyed to the Trello notification ID, so dismissing something sticks no matter which page you're on, and a reworded follow-up is correctly treated as new.
- Reads are read-only. The one thing that writes is **Reply**, and only when you press Send. Both stay on trello.com; nothing goes to any third party.

If the request fails — not logged in on that tab, say — it tells you why and falls back to reading the page.

Your handle is set to `@rafay10` (plus `@rafay` and `Rafay`). If you ever change it, edit it once in **Manage questions → People / names to watch**.

Being a **member** of a card is a different thing from being **tagged** in its comments — the mentions question ignores avatars entirely. Want the membership view? Enable "Which cards am I on?" in Manage questions.

## Two things to know about its limits

- **On Trello** it uses Trello's own notification data, so nothing needs to be visible on screen. Trello returns your 100 most recent notifications, which is well past the 7-day window.
- **Everywhere else** it reads the rendered text of the page (including `aria-label`s, which is how Google Calendar and Slack expose most of their content). It can't see content that hasn't loaded — if a page lazy-loads, scroll first, then Rescan.
- "New" is relative to the last time you marked things handled. On Trello that's tracked per notification, account-wide; elsewhere it's per question per URL path.

## Privacy

Page text is matched in memory and discarded. Only short hashes (and Trello notification IDs) are stored locally in `chrome.storage.local` so new-detection works; your questions sync via your Chrome profile.

There is no server and no third party. The single network request in the whole extension is the read of your own Trello notifications, issued from inside your Trello tab with the session you already have — the same call Trello's web app makes. Nothing is written, and nothing is sent elsewhere.



## Desktop notifications

When someone tags you in a Trello comment, a notification appears on your desktop within a second or two:

```
┌──────────────────────────────────────────┐
│ ●  Paul Eleazar tagged you               │
│    Hi @rafay10 , Ufredo uploaded his YTD │
│    paystubs. Already sorted in Q3 folder.│
│    [QTM3] Ufredo Barahona                │
│              [ Open card ]  [ Done ]     │
└──────────────────────────────────────────┘
```

- **Click it** (or *Open card*) → that card opens in your existing Trello tab, Chrome comes to the front, and it's marked done.
- **Done** → cleared without dragging you anywhere.
- Only comments that actually tag you notify. Admin chatter, and being added to a card, don't.
- Each tag notifies once, ever. Repeat follow-ups with the same wording stay quiet.
- A flood is capped at 5 popups plus one "4 more tags waiting" summary.

**How the "instant" part works:** a small script on trello.com watches Trello's own notification bell. The moment Trello updates it, the extension asks Trello what changed and pops the notification — no waiting for a timer. A 1-minute alarm and a 20-second heartbeat run as backstops, and it checks whenever you focus the tab or the window.

**The one requirement: keep a Trello tab open** (pinning it is ideal). Your Trello login lives in that tab, and it's what makes reading your mentions possible. With no Trello tab open there's nothing to read, and you'll see the tags next time you open Trello.

If no notification ever appears, Chrome itself may not be allowed to notify you — on macOS check System Settings → Notifications → Chrome. Settings has a **Send a test one** button and a **Check Trello now** button that tells you exactly what it found.

## The Ask box (no key needed)

Type a question, press Enter. It turns your question into search terms and runs them against your Trello notifications and the current page, then answers with a one-line summary plus the actual matching comments. Instant, offline, and it can't invent anything — every line you see is a real quote from your own data.

It understands:

| You type | It does |
|---|---|
| *who tagged me about paystubs?* | names the person, shows the comment |
| *who tagged me this week?* | lists everyone, newest first |
| *what did Gina want?* | filters to that person |
| *when did Paul last message me?* | answers with an age and exact timestamp |
| *how many people tagged me?* | answers with a number |
| *any unread mentions?* | only what Trello still counts unread |
| *anything about "quarterly organizer"?* | quoted phrases matched exactly |
| *which documents were uploaded?* | comments about files, uploads, attachments |
| *anything new for me today* | today only, unhandled only |

Time words (*today*, *yesterday*, *this week*, *ever*) override the toolbar's date range for that one question. Saying *me* or *my* restricts it to comments that actually tag you; leave it out to search everything, including the admins' chatter. When nothing matches it says so plainly rather than padding an answer.

## Optionally: have Claude write it up

*Everything above needs no key. This bit does.*

Once a key is saved, every local answer gains a **have Claude write it up** link, which turns the same data into prose ("three people are waiting on you; the most urgent is..."). Nothing is sent unless you click it.

**Setup, once:** Manage questions → **Ask Claude** → paste an Anthropic API key from [console.anthropic.com](https://console.anthropic.com/settings/keys). Paste it yourself; nobody else needs to see it. It's kept in `chrome.storage.local` on this machine, never synced, and sent only to Anthropic's API.

**Things worth knowing**

- Nothing is sent until you click **have Claude write it up**. Pressing Ask itself stays fully local.
- What gets sent: your Trello notifications (actor, card, comment text, timestamps), the items your saved questions matched, and the visible text of the current page — capped at ~14,000 characters. Consider that before asking on a page with client PII.
- Each answer prints its token count, so cost is visible per question. **Haiku 4.5** is roughly a tenth of Sonnet's price and handles "who tagged me about X" perfectly well; switch models in settings.
- Claude is instructed to answer *only* from that context and to say when something isn't there, rather than guessing. It's told to name the card and quote the comment.
- Follow-ups keep the thread ("and what did Gina want?"). **clear thread** starts fresh.
- Turn the box off entirely with the *Show the Ask box* toggle, or hit **Forget my key**.

Example:

> **who tagged me about paystubs?**
> Paul Eleazar tagged you 21h ago on "[QTM3] Ufredo Barahona": Ufredo's YTD paystubs and YTD financials are uploaded and sorted in his Q3 folder. It's a heads-up, so nothing is strictly needed from you — though the Quarterly Organizer and 2025 returns are still outstanding on that card.
