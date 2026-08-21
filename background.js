/* Background worker: keeps the toolbar count up to date, and pops a desktop
   notification the moment someone tags you on a Trello card. */

if (typeof importScripts === 'function') importScripts('common.js');

/* Fire-and-forget messaging. With no listener (panel closed, worker asleep)
   Chrome rejects the promise — that is expected, not a failure, so swallow it.
   A plain try/catch cannot: the rejection is asynchronous. */
function tell(msg, cb) {
  try {
    const p = cb ? chrome.runtime.sendMessage(msg, cb) : chrome.runtime.sendMessage(msg);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) {}
}

const POLL_FLOOR_MS = 4000;   // never hammer Trello more than this
const MAX_POPUPS = 5;         // per check, so 20 tags don't bury your screen
let lastPoll = 0;

/* ---------- settings ---------- */

async function getNotify() {
  const got = await chrome.storage.sync.get({ notify: null });
  return Object.assign({ on: true, everyMin: 1, sound: true }, got.notify || {});
}

async function autoCheckEnabled() {
  const got = await chrome.storage.sync.get({ autoCheck: true });
  return got.autoCheck !== false;
}

/* ---------- toolbar count ---------- */

async function updateBadge(tabId, url) {
  try {
    if (!url || !/^https?:/i.test(url) || !(await autoCheckEnabled())) {
      await chrome.action.setBadgeText({ tabId, text: '' });
      return;
    }
    const { results } = await QA.runScan(tabId, url);
    const totalNew = results.reduce((n, r) => n + r.newCount, 0);
    await chrome.action.setBadgeBackgroundColor({ color: '#c2410c' });
    await chrome.action.setBadgeText({ tabId, text: totalNew ? String(Math.min(totalNew, 999)) : '' });
  } catch (e) {
    try { await chrome.action.setBadgeText({ tabId, text: '' }); } catch (e2) {}
  }
}

/* ---------- notifications ---------- */

async function findTrelloTab() {
  const tabs = await chrome.tabs.query({ url: ['*://trello.com/*', '*://*.trello.com/*'] });
  return (tabs || []).filter((t) => t.id)[0];
}

async function mentionNames() {
  const rules = await QA.getRules();
  const r = rules.filter((x) => x.id === 'r_tagged_me')[0];
  return (r && r.names && r.names.length) ? r.names : QA.ME;
}

/* async, and every caller awaits it: an MV3 service worker can be torn down
   the instant its listener returns, and a fire-and-forget fetch() to the
   phone relay loses that race far more often than the near-instant
   chrome.notifications.create() call does. */
/* board logging is independent of whether phone push is even switched on —
   it only needs Settings > Mobile notifications' server + code filled in,
   and it covers every fresh tag, not just the ones popped as OS notifications */
async function fileTagCard(item) {
  const title = (item.actor || 'Someone') + ' tagged you';
  let context = item.cardName || '';
  let due = '';
  let dueAt = '';
  let dueComplete = false;
  /* best effort: the notification payload never carries a due date and only
     sometimes carries the card name, so ask Trello for the real thing when
     there's a card to ask about. Needs an open Trello tab (same constraint
     as the popup's own due-date lookups) — falls back to whatever the
     notification had if there isn't one, rather than blocking the card. */
  if (item.cardId) {
    const got = await QA.cardDetailsFor(item.cardId);
    if (got && got.ok) {
      if (got.name) context = got.name;
      if (got.due) {
        dueAt = got.due;
        dueComplete = !!got.dueComplete;
        const lab = QA.dueLabel(got.due, got.dueComplete);
        if (lab) due = lab.text;
      }
    }
  }
  /* the notification this tag came from, so a later reply or board move can
     tell Trello (and so the popup) it's been dealt with — same "tn:" prefix
     rememberHandled strips elsewhere */
  const notifId = item.hash && item.hash.indexOf('tn:') === 0 ? item.hash.slice(3) : (item.notificationId || '');
  await QA.fileCard({
    title: title, body: item.text || '', url: item.href || '',
    context: context, due: due, dueAt: dueAt, dueComplete: dueComplete,
    cardId: item.cardId || '', notifId: notifId, actorUser: item.actorUser || ''
  });
}

async function notifyOne(item) {
  const id = 'tag|' + item.hash;
  const title = (item.actor || 'Someone') + ' tagged you';
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: title,
    message: (item.text || '').slice(0, 200),
    contextMessage: item.cardName || 'Trello',
    buttons: [{ title: 'Open card' }, { title: 'Done' }],
    priority: 2,
    requireInteraction: false
  });
  /* the push notification body stays short (web push has a ~4KB payload cap
     and the OS tray truncates anyway); the board card gets the full text */
  await QA.pushToPhone(title, (item.text || '').slice(0, 500), item.href || '');
  await fileTagCard(item);
  return id;
}

/* ---------- reaching Trello with no tab open ----------
   Normally we run inside your Trello tab so your login applies. The worker can
   sometimes fetch Trello directly with the same cookies — whether Chrome sends
   them depends on how Trello marks its session cookie, so this is attempted and
   the result remembered rather than assumed. */

async function directNotifications() {
  try {
    const res = await fetch(QA.NOTIF_URL + QA.NOTIF_QS, {
      credentials: 'include',
      headers: { Accept: 'application/json' }
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: 'not-signed-in', status: res.status };
    }
    if (!res.ok) return { ok: false, reason: 'refused', status: res.status };
    const json = await res.json();
    if (!Array.isArray(json)) return { ok: false, reason: 'unexpected response' };
    return { ok: true, items: QA.shapeNotifications(json), how: 'direct' };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

/* remember which route worked, so the UI can tell you honestly */
async function setReach(how, detail) {
  try {
    await chrome.storage.local.set({ trelloReach: { how: how, detail: detail || '', at: Date.now() } });
  } catch (e) {}
}

async function getReach() {
  try {
    const g = await chrome.storage.local.get({ trelloReach: null });
    return g.trelloReach;
  } catch (e) { return null; }
}

/* Read notifications by whichever route is available: the tab if you have one
   (proven), otherwise straight from the worker (no tab needed). */
async function readNotifications() {
  const tab = await findTrelloTab();
  if (tab) {
    try {
      const got = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN', func: QA.fetchTrelloNotifications
      });
      const raw = got && got[0] && got[0].result;
      if (raw && raw.ok) {
        await setReach('tab', 'read through your open Trello tab');
        return { raw: raw, tab: tab, how: 'tab' };
      }
    } catch (e) {}
  }

  const direct = await directNotifications();
  if (direct.ok) {
    await setReach('direct', 'read straight from Trello — no tab needed');
    return { raw: { ok: true, items: direct.items }, tab: tab || null, how: 'direct' };
  }
  await setReach('none', direct.reason === 'not-signed-in'
    ? 'Trello would not accept the request without a tab — open Trello once and leave it open'
    : 'could not reach Trello (' + (direct.status || direct.reason) + ')');
  return { raw: null, tab: tab || null, how: 'none', why: direct.reason };
}

/* the heart of it: ask Trello what's new, pop anything we haven't popped before */
/* checkTrello can be triggered from several places at once (the 1-minute
   alarm, a Trello tab finishing a load, a content-script ping) and now does
   real network round-trips per fresh tag (push + board filing), which take
   long enough that two triggers can genuinely overlap. Without this guard,
   an overlapping call re-reads "notified" from storage before the first
   call has finished writing it back, sees the same tags as still fresh, and
   double-files them on the board. Single-flight: a call that arrives while
   one is already running just waits for and reuses that same result. */
let checkInFlight = null;

function checkTrello(reason) {
  if (checkInFlight) return checkInFlight;
  checkInFlight = runCheckTrello(reason).finally(() => { checkInFlight = null; });
  return checkInFlight;
}

async function runCheckTrello(reason) {
  const cfg = await getNotify();
  if (!cfg.on) return { skipped: 'off' };

  const now = Date.now();
  if (now - lastPoll < POLL_FLOOR_MS) return { skipped: 'too soon' };
  lastPoll = now;

  const read = await readNotifications();
  const tab = read.tab;
  const raw = read.raw;
  if (!raw || !raw.ok) return { skipped: 'could not reach Trello (' + (read.why || 'no route') + ')' };

  const snaps = await QA.getSnapshots();
  const group = QA.trelloResults(raw, snaps, {
    sinceMs: Date.now() - 7 * 864e5,
    names: await mentionNames()
  });

  const store = await chrome.storage.local.get({ notified: {}, pending: {} });
  const notified = store.notified || {};
  const pending = store.pending || {};

  const fresh = group.items.filter((i) => i.isNew && !notified[i.hash]);
  if (!fresh.length) {
    await chrome.storage.local.set({ notified: notified });
    return { popped: 0, reason: reason };
  }

  /* mark these handled and persist BEFORE the slow per-item network work,
     so a same-second overlapping call sees them as already spoken for */
  fresh.forEach((i) => { notified[i.hash] = now; });
  const keys = Object.keys(notified);
  if (keys.length > 600) {
    keys.sort((a, b) => notified[a] - notified[b]).slice(0, keys.length - 600)
      .forEach((k) => delete notified[k]);
  }
  await chrome.storage.local.set({ notified: notified });

  for (const item of fresh.slice(0, MAX_POPUPS)) {
    const id = await notifyOne(item);
    pending[id] = { url: item.href, shortLink: item.shortLink || '', hash: item.hash, actor: item.actor, card: item.cardName };
  }

  if (fresh.length > MAX_POPUPS) {
    const extra = fresh.length - MAX_POPUPS;
    const moreTitle = extra + ' more ' + (extra === 1 ? 'tag' : 'tags') + ' waiting';
    chrome.notifications.create('more|' + now, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: moreTitle,
      message: 'Open the extension to work through them.',
      priority: 1
    });
    await QA.pushToPhone(moreTitle, 'Open the extension to work through them.', '');
    /* these didn't get their own OS popup, but they're still new tags — file
       them on the board same as the ones that did */
    for (const item of fresh.slice(MAX_POPUPS)) { await fileTagCard(item); }
  }

  await chrome.storage.local.set({ pending: pending });
  if (tab) { try { await updateBadge(tab.id, tab.url); } catch (e) {} }
  tell({ type: 'trelloUpdated' });   // live-update an open panel, if one is open
  return { popped: Math.min(fresh.length, MAX_POPUPS), total: fresh.length, reason: reason, how: read.how };
}

/* clicking the notification: open that card, and count it as dealt with */
async function openFromNotification(notifId, markDone) {
  const store = await chrome.storage.local.get({ pending: {} });
  const p = (store.pending || {})[notifId];
  chrome.notifications.clear(notifId);
  if (!p) return;

  if (markDone) {
    try { await QA.setItemsSeen(QA.TRELLO_SNAPKEY, [p.hash], true); } catch (e) {}
  }
  if (p.url) {
    /* same as the panel's Open card: route inside the tab you already have open
       rather than reloading it */
    await QA.openCardSmart({ href: p.url, shortLink: p.shortLink || '' });
  }
  delete store.pending[notifId];
  await chrome.storage.local.set({ pending: store.pending });
}

chrome.notifications.onClicked.addListener((id) => {
  if (id.indexOf('tag|') === 0) openFromNotification(id, true);
  else chrome.notifications.clear(id);
});

/* "Done" should mark it handled without dragging you into the card */
async function doneFromNotification(notifId) {
  const store = await chrome.storage.local.get({ pending: {} });
  const p = (store.pending || {})[notifId];
  chrome.notifications.clear(notifId);
  if (!p) return;
  try { await QA.setItemsSeen(QA.TRELLO_SNAPKEY, [p.hash], true); } catch (e) {}
  delete store.pending[notifId];
  await chrome.storage.local.set({ pending: store.pending });
}

chrome.notifications.onButtonClicked.addListener((id, idx) => {
  if (id.indexOf('tag|') !== 0) { chrome.notifications.clear(id); return; }
  if (idx === 0) openFromNotification(id, true);   // Open card
  else doneFromNotification(id);                   // Done, stay where you are
});


/* ---------- weekly follow-up draft ----------
   Reads next week's calendar in a background tab, matches each meeting to its
   card, collects the documents still outstanding, and saves a draft for you to
   review. It never posts anything by itself. */

async function readNextWeekCalendar() {
  const cfg = await QA.getFollowup();
  const range = QA.nextWeekRange();
  const url = QA.calendarUrl(range.start, cfg.gcalUser);
  const started = Date.now();
  let tab = null;
  try {
    tab = await chrome.tabs.create({ url: url, active: false });

    /* Ask as soon as the grid exists rather than sleeping for a fixed six
       seconds. Poll every 300ms and stop the moment events appear. */
    let labels = [];
    let chips = [];
    const deadline = Date.now() + 12000;
    let settled = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      let res = null;
      try {
        const got = await chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: 'MAIN', func: QA.extractCalendarEvents
        });
        res = got && got[0] && got[0].result;
      } catch (e) {
        continue;          // page still navigating; try again
      }
      const found = (res && res.labels) || [];
      if ((res && res.chips || []).length >= chips.length) chips = res.chips || chips;
      if (found.length > labels.length) {
        labels = found;
        settled = 0;
        continue;          // still filling in — give it another tick
      }
      if (labels.length) {
        settled++;
        if (settled >= 2) break;   // count stable twice: the grid is drawn
      }
    }

    return { ok: labels.length > 0, labels: labels, chips: chips, range: range, url: url, tookMs: Date.now() - started };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), range: range, url: url, tookMs: Date.now() - started };
  } finally {
    if (tab && tab.id) { try { await chrome.tabs.remove(tab.id); } catch (e2) {} }
  }
}

/* "11am" / "1pm–2pm" / "9:30am" -> minutes past midnight, for ordering only */
function minutesOf(time) {
  const m = String(time || '').match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!m) return 9999;
  let h = parseInt(m[1], 10) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return h * 60 + (parseInt(m[2], 10) || 0);
}

async function runInTrello(func, args) {
  const tab = await findTrelloTab();
  if (!tab) return null;
  try {
    const got = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: 'MAIN', func: func, args: args || []
    });
    return got && got[0] && got[0].result;
  } catch (e) {
    return null;
  }
}

const CARD_MAP_TTL = 60 * 864e5;   // two months

async function getCardMap() {
  const got = await chrome.storage.local.get({ cardMap: {} });
  const map = got.cardMap || {};
  const now = Date.now();
  Object.keys(map).forEach((k) => { if (!map[k] || now - (map[k].at || 0) > CARD_MAP_TTL) delete map[k]; });
  return map;
}

function cardKeyFor(ev) {
  return (ev.code || '') + '|' + ((ev.clientTokens || [])[0] || (ev.client || '').toLowerCase());
}

/* run a handful at a time — sequential was the slow part */
async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    const slice = items.slice(i, i + size);
    const done = await Promise.all(slice.map(fn));
    done.forEach((d) => out.push(d));
  }
  return out;
}

async function prepareFollowup(reason) {
  const cfg = await QA.getFollowup();
  const cal = await readNextWeekCalendar();
  if (!cal.ok) {
    const draft = {
      at: Date.now(), reason: reason, entries: [], text: '',
      problem: 'Could not read your Google Calendar. Are you signed in to Google in this browser?',
      weekOf: cal.range.start
    };
    await chrome.storage.local.set({ followupDraft: draft });
    return draft;
  }

  const rough = [];
  const seen = {};
  let ignored = 0;
  let skipped = 0;
  (cal.labels || []).forEach((l) => {
    const p = QA.parseCalendarLabel(l);
    if (!p) {
      // it looked like a real event but carried no client name — still worth counting
      if (/\d{1,2}(?::\d{2})?\s?(?:am|pm)/i.test(l)) ignored++;
      return;
    }
    const key = p.raw.toLowerCase();
    if (seen[key]) return;
    seen[key] = 1;
    // notetakers, booking links, invite chatter
    if (QA.eventIsSkipped(p, cfg.skipText)) { skipped++; return; }
    // only the meetings that carry the required code (QTM by default)
    if (!QA.eventMatchesRequired(p, cfg.requireText)) { ignored++; return; }
    rough.push(p);
  });
  // the same client appears twice on the calendar; one comment per client
  const parsed = QA.dedupeEvents(rough);

  const cardMap = await getCardMap();
  const trelloStarted = Date.now();
  let cacheHits = 0;

  const built = await inBatches(parsed.slice(0, cfg.maxMeetings), 6, async (ev) => {
    const key = cardKeyFor(ev);
    const cached = cardMap[key];
    let chosen = null;
    let candidates = [];

    if (cached && cached.id) {
      chosen = { id: cached.id, name: cached.name, shortLink: cached.shortLink };
      cacheHits++;
    } else {
      // search on the client's name alone — codes and times only confuse Trello search
      let found = await runInTrello(QA.searchTrelloCards, [ev.client]);
      let cards = (found && found.ok && found.cards) || [];
      let best = QA.bestCardForEvent(ev, cards);

      // a full name that finds nothing? try just the first name
      const first = (ev.clientTokens || [])[0];
      if (!best && first && first !== ev.client.toLowerCase()) {
        found = await runInTrello(QA.searchTrelloCards, [first]);
        cards = (found && found.ok && found.cards) || [];
        best = QA.bestCardForEvent(ev, cards);
      }
      if (best && best.card) chosen = best.card;
      if (best && best.ambiguous) {
        candidates = best.ambiguous.map((c) => ({ id: c.id, name: c.name, shortLink: c.shortLink }));
      }
    }

    const chip = QA.chipForEvent(ev, cal.chips || []);
    const when = QA.meetingDate(ev, chip, cal.range && cal.range.start);
    const entry = {
      client: ev.client || ev.title, code: ev.code || '',
      clientTokens: ev.clientTokens || [],
      day: when ? QA.DAY_SHORT[when.getDay()] : ev.day,
      dateMs: when ? when.getTime() : 0,
      time: ev.time, date: ev.date,
      cardId: chosen ? chosen.id : '',
      cardName: chosen ? chosen.name : '',
      shortLink: chosen ? chosen.shortLink : '',
      candidates: candidates,
      missing: [], total: 0, done: 0
    };

    if (chosen) {
      /* the checklists and the comments are two different endpoints on the same
         card — asking for both at once halves the wait */
      /* One request for the checklists AND the comments — half the round trips.
         If it fails we still ask for the checklists on their own, so a bad
         response costs us the history but never the list of what is missing. */
      let cl = await runInTrello(QA.fetchCardBundle, [chosen.id]);
      const cm = cl;
      if (!cl || !cl.ok) cl = await runInTrello(QA.fetchCardChecklists, [chosen.id]);
      if (cm && cm.ok) {
        entry.chase = QA.chaseState(cm.comments, cfg.admin, { days: cfg.chaseDays });
        entry.history = QA.readCardHistory(cm.comments, { admin: cfg.admin });
        entry.commentsRead = (cm.comments || []).length;
      } else {
        /* say so. Silently drafting the generic four-bullet ask, as if the card
           had no history, is exactly how this went unnoticed before. */
        entry.commentsError = (cm && (cm.error || ('Trello said no (' + cm.status + ')'))) ||
          'could not reach Trello';
      }
      if (cl && cl.ok) {
        entry.missing = cl.missing || [];
        entry.total = cl.total || 0;
        entry.done = cl.done || 0;
        cardMap[key] = { id: chosen.id, name: chosen.name, shortLink: chosen.shortLink, at: Date.now() };
      } else if (cached) {
        // the remembered card no longer answers — forget it and look again next time
        delete cardMap[key];
        entry.cardId = '';
        entry.cardName = '';
      }
    }

    if (entry.cardId) {
      const found = QA.relevantAsks(entry.missing, cfg.wanted);
      entry.asks = found.asks;
      entry.hiddenCount = found.hidden;
      entry.text = QA.buildCardMessage(entry, cfg.admin, cfg.wanted);
    } else {
      entry.asks = [];
      entry.hiddenCount = 0;
      entry.text = '';
    }
    entry.include = QA.shouldSendByDefault(entry, cfg.wanted);
    entry.sent = false;
    return entry;
  });

  const entries = [];
  built.forEach((entry) => {
    // two calendar events can still land on one card — keep the first only
    const clash = entry.cardId && entries.filter((e) => e.cardId === entry.cardId)[0];
    if (clash) {
      if (!clash.time && entry.time) clash.time = entry.time;
      if (!clash.day && entry.day) clash.day = entry.day;
      if (!clash.dateMs && entry.dateMs) clash.dateMs = entry.dateMs;
      clash.text = QA.buildCardMessage(clash, cfg.admin, cfg.wanted);
      return;
    }
    entries.push(entry);
  });
  /* now that we know the dates, put the week in order — Monday first */
  entries.sort((a, b) => {
    if (a.dateMs && b.dateMs && a.dateMs !== b.dateMs) return a.dateMs - b.dateMs;
    if (!!a.dateMs !== !!b.dateMs) return a.dateMs ? -1 : 1;
    return minutesOf(a.time) - minutesOf(b.time);
  });

  await chrome.storage.local.set({ cardMap: cardMap });
  const trelloMs = Date.now() - trelloStarted;

  const draft = {
    at: Date.now(),
    reason: reason,
    weekOf: cal.range.start,
    admin: cfg.admin,
    requireText: cfg.requireText || '',
    ignored: ignored + skipped,
    skipped: skipped,
    calendarMs: cal.tookMs || 0,
    trelloMs: trelloMs,
    cacheHits: cacheHits,
    chips: cal.chips || [],
    entries: entries,
    problem: entries.length ? ''
      : (ignored
          ? 'No ' + (cfg.requireText || 'matching') + ' meetings next week (' + ignored + ' other meetings ignored).'
          : 'No meetings found for next week.')
  };
  await chrome.storage.local.set({ followupDraft: draft });
  return draft;
}

async function notifyFollowup(draft) {
  const n = (draft.entries || []).length;
  const missing = (draft.entries || []).filter((e) => (e.asks || []).length).length;
  const message = n
    ? n + ' meeting' + (n === 1 ? '' : 's') + ' next week — ' + missing +
      ' card' + (missing === 1 ? '' : 's') + ' need a follow-up comment.'
    : (draft.problem || 'Nothing found for next week.');
  chrome.notifications.create('followup|' + Date.now(), {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: 'Follow-up draft ready',
    message: message,
    contextMessage: 'Click to review before anything is sent',
    priority: 1
  });
  await QA.pushToPhone('Follow-up draft ready', message, '');
}

/* ---------- daily board update (scheduled) ----------
   The board page's own "Today's update" button calls prepareDailyUpdate
   directly via a message so the manual and scheduled paths share one
   implementation; this is just what runs it unattended and tells him it's
   there. Nothing is sent anywhere on its own — same as the weekly
   follow-up, this only ever fills a draft and notifies. */

async function prepareDailyUpdate(reason) {
  const cfg = await QA.getDailyUpdate();
  let cards;
  try {
    cards = await QA.fetchCards();
  } catch (e) {
    const draft = {
      at: Date.now(), reason: reason, text: '',
      problem: 'Could not read the board — fill in the server address and pairing code in Settings first.'
    };
    await chrome.storage.local.set({ dailyUpdateDraft: draft });
    return draft;
  }
  let draft;
  try {
    const res = await QA.draftDailyUpdate(cards, cfg.recipient);
    draft = { at: Date.now(), reason: reason, text: res.text };
  } catch (e) {
    draft = { at: Date.now(), reason: reason, text: '', problem: (e && e.message) || 'Could not draft the update.' };
  }
  await chrome.storage.local.set({ dailyUpdateDraft: draft });
  return draft;
}

async function notifyDailyUpdate(draft) {
  const message = draft.problem || (draft.text ? draft.text.slice(0, 150) : 'Ready to review.');
  chrome.notifications.create('dailyupdate|' + Date.now(), {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: draft.problem ? 'Could not draft today\'s update' : 'Today\'s update is ready',
    message: message,
    contextMessage: 'Click to review before you send it',
    priority: 1
  });
  if (!draft.problem) await QA.pushToPhone('Today\'s update is ready', message, '');
}

async function scheduleDailyUpdate() {
  const cfg = await QA.getDailyUpdate();
  if (!cfg.on) { chrome.alarms.clear('dailyUpdate'); return; }
  const now = new Date();
  const next = new Date(now);
  next.setHours(cfg.hour, cfg.minute || 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  chrome.alarms.create('dailyUpdate', { when: next.getTime(), periodInMinutes: 24 * 60 });
}

chrome.notifications.onClicked.addListener((id) => {
  if (id.indexOf('followup|') === 0) {
    chrome.notifications.clear(id);
    chrome.tabs.create({ url: chrome.runtime.getURL('followup.html') });
  }
  if (id.indexOf('dailyupdate|') === 0) {
    chrome.notifications.clear(id);
    chrome.tabs.create({ url: chrome.runtime.getURL('board.html') });
  }
});

async function scheduleFollowup() {
  const cfg = await QA.getFollowup();
  if (!cfg.on) { chrome.alarms.clear('followup'); return; }
  const now = new Date();
  const next = new Date(now);
  next.setHours(cfg.hour, cfg.minute, 0, 0);
  const wd = typeof cfg.weekday === 'number' ? cfg.weekday : 1;
  let days = (wd - next.getDay() + 7) % 7;
  if (days === 0 && next.getTime() <= now.getTime()) days = 7;
  next.setDate(next.getDate() + days);
  chrome.alarms.create('followup', { when: next.getTime(), periodInMinutes: 7 * 24 * 60 });
}

/* ---------- triggers ---------- */

chrome.runtime.onInstalled.addListener(async () => {
  const rules = await QA.getRules();
  const have = rules.map((r) => r.id);
  const missing = QA.DEFAULT_RULES.filter((d) => have.indexOf(d.id) === -1);

  let touched = false;
  rules.forEach((r) => {
    const d = QA.DEFAULT_RULES.filter((x) => x.id === r.id)[0];
    if (!d || d.name !== r.name) return;
    const union = Array.from(new Set((r.builtins || []).concat(d.builtins || [])));
    if (union.length !== (r.builtins || []).length) { r.builtins = union; touched = true; }
    if (r.id === 'r_my_cards' && r.enabled) { r.enabled = false; touched = true; }
  });
  if (missing.length || touched) await QA.setRules(missing.concat(rules));

  const fu = await QA.getFollowup();
  if (fu.admin === 'peleazar') await QA.setFollowup({ admin: 'pauleleazar1' });

  chrome.alarms.create('trello', { periodInMinutes: 1 });
  scheduleFollowup();
  scheduleDailyUpdate();
  await checkTrello('installed');
});

chrome.runtime.onStartup.addListener(async () => {
  chrome.alarms.create('trello', { periodInMinutes: 1 });
  scheduleFollowup();
  scheduleDailyUpdate();
  await checkTrello('startup');
});

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === 'trello') await checkTrello('alarm');
  if (a.name === 'followup') {
    const draft = await prepareFollowup('weekly');
    await notifyFollowup(draft);
  }
  if (a.name === 'dailyUpdate') {
    const draft = await prepareDailyUpdate('scheduled');
    await notifyDailyUpdate(draft);
  }
});

const debounce = new Map();
function queueCheck(tabId, url) {
  clearTimeout(debounce.get(tabId));
  debounce.set(tabId, setTimeout(() => updateBadge(tabId, url), 1200));
}

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status === 'complete' && tab && tab.url) {
    queueCheck(tabId, tab.url);
    if (QA.isTrello(tab.url)) await checkTrello('trello tab loaded');
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab && tab.url) queueCheck(tabId, tab.url);
  } catch (e) {}
});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg) return false;
  if (msg.type === 'refreshBadge' && msg.tabId) updateBadge(msg.tabId, msg.url);
  if (msg.type === 'trelloMaybeNew') { checkTrello(msg.why || 'page nudge').then((r) => respond && respond(r)); return true; }
  if (msg.type === 'testNotification') {
    chrome.notifications.create('test|' + Date.now(), {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Paul Eleazar tagged you',
      message: 'Hi @rafay10 , Ufredo uploaded his YTD paystubs and YTD financials.',
      contextMessage: '[QTM3] Ufredo Barahona — this is a test',
      priority: 2
    });
  }
  if (msg.type === 'checkNow') { checkTrello('asked').then((r) => respond && respond(r)); return true; }
  if (msg.type === 'testPush') {
    QA.pushToPhone('Nudge', 'Test notification — your phone is paired correctly.', '')
      .then((r) => respond && respond(r));
    return true;
  }
  if (msg.type === 'handled' && msg.hash) {
    /* you dealt with it in the panel, so it must never pop on the desktop */
    (async () => {
      const s = await chrome.storage.local.get({ notified: {} });
      const n = s.notified || {};
      if (msg.undo) delete n[msg.hash]; else n[msg.hash] = Date.now();
      await chrome.storage.local.set({ notified: n });
      respond && respond({ ok: true });
    })();
    return true;
  }
  if (msg.type === 'trelloReach') {
    (async () => {
      let r = await getReach();
      if (!r) { await checkTrello('reach check'); r = await getReach(); }
      respond && respond(r || { how: 'unknown', detail: '' });
    })();
    return true;
  }
  if (msg.type === 'prepareFollowup') {
    prepareFollowup('asked').then((d) => respond && respond(d));
    return true;
  }
  if (msg.type === 'rescheduleFollowup') { scheduleFollowup(); }
  if (msg.type === 'prepareDailyUpdate') {
    prepareDailyUpdate('asked').then((d) => respond && respond(d));
    return true;
  }
  if (msg.type === 'rescheduleDailyUpdate') { scheduleDailyUpdate(); }
  if (msg.type === 'chaseState') {
    (async () => {
      const cfg = await QA.getFollowup();
      const cm = await runInTrello(QA.fetchCardComments, [msg.cardId]);
      if (!cm || !cm.ok) { respond && respond({ ok: false, reason: 'Could not read that card\'s comments. Is Trello open?' }); return; }
      respond && respond({ ok: true, chase: QA.chaseState(cm.comments, cfg.admin, { days: cfg.chaseDays }) });
    })();
    return true;
  }
  respond && respond({ ok: true });
  return false;
});

if (typeof self !== 'undefined') self.__bg = { checkTrello, readNotifications, directNotifications, getReach, openFromNotification, doneFromNotification, findTrelloTab, updateBadge, getNotify, prepareFollowup, readNextWeekCalendar, scheduleFollowup, notifyFollowup, prepareDailyUpdate, scheduleDailyUpdate, notifyDailyUpdate };
