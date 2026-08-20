/* Nudge — shared engine.
   Loaded by background.js, popup.js, sidepanel.js, options.js.
   The only network call in this extension is a read of your own Trello
   notifications, made from inside the Trello tab with your existing login.
   Nothing is sent to any third party. */

var QA = (function () {
  const MAX_SNIPPET = 300;
  const MAX_ITEMS_PER_RULE = 60;

  /* ---------- built-in patterns ---------- */

  const BUILTINS = {
    documents: {
      label: 'Documents / file links',
      test: (item) => {
        const re = /\.(pdf|docx?|xlsx?|xlsm|csv|pptx?|txt|rtf|zip|pages|numbers|key|odt|ods|jpe?g|png|heic|tiff?)\b/i;
        if (item.href && re.test(item.href.split('?')[0])) return true;
        if (re.test(item.text)) return true;
        // Google Drive / Dropbox / OneDrive style doc links
        if (item.href && /(drive|docs)\.google\.com\/(file|document|spreadsheets|presentation)\//i.test(item.href)) return true;
        if (item.href && /(dropbox\.com\/(s|scl)\/|1drv\.ms|sharepoint\.com\/.*\/Doc)/i.test(item.href)) return true;
        return false;
      }
    },
    dates: {
      label: 'Dates',
      test: (item) => /\b(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2})\b/i.test(item.text)
    },
    money: {
      label: 'Amounts of money',
      test: (item) => /(\$|USD|EUR|GBP|£|€)\s?\d[\d,]*(\.\d{2})?\b/i.test(item.text)
    },
    times: {
      label: 'Times / meeting slots',
      test: (item) => /\b\d{1,2}(:\d{2})?\s?(am|pm)\b|\b\d{1,2}:\d{2}\b/i.test(item.text)
    },
    deadlines: {
      label: 'Deadline / due language',
      test: (item) => /\b(due|deadline|by end of|overdue|expires?|expiry|filing date|submit by|no later than)\b/i.test(item.text)
    },
    assignments: {
      label: 'Assignment language',
      test: (item) => /\b(assigned to|assignee|assigned you|reassigned|owner:|owned by|responsible|action item|to-?do for|task for|please handle|over to you|your task)\b/i.test(item.text)
    },
    mentions: {
      label: '@mentions',
      test: (item) => /(^|[\s(\[])@[a-z0-9][a-z0-9._-]{1,30}\b/i.test(item.text)
    },
    tagged: {
      label: 'Someone tagged you',
      // Trello's own wording for "you were mentioned", which appears even when
      // the handle itself is rendered as a display name rather than @something
      test: (item) => /\b(mentioned you|tagged you|added you to|assigned you|mentioned on|you were mentioned)\b/i.test(item.text)
    },
    messages: {
      label: 'Message / sender language',
      test: (item) => /\b(unread|new message|messaged you|replied|sent you|dm|direct message|mentioned you|commented|from:|inbox)\b/i.test(item.text)
    }
  };

  /* "Gina Dorsey mentioned you on Tynar Corp" -> a one-line headline.
     Turns raw notification/comment text into "who tagged you, and where". */
  function mentionSummary(text, myNames) {
    const t = normalize(text);
    const m = t.match(/([A-Z][\wÀ-ÿ'’.-]+(?:\s+[A-Z][\wÀ-ÿ'’.-]+){0,2})\s+(mentioned you|tagged you|added you to|added you|assigned you|commented on|left a comment on|left a comment|replied to|replied|added an attachment to|added an attachment|attached)/);
    if (!m) return null;
    const actor = m[1];
    const verbRaw = m[2].toLowerCase();
    // if my own handle/name is in the body, they tagged me — say so plainly
    const tagged = (myNames || []).some((n) => {
      const nn = normalize(n);
      return nn && t.toLowerCase().indexOf(nn.toLowerCase()) !== -1;
    });
    let verb;
    if (/mentioned you|tagged you|added you|assigned you/.test(verbRaw)) verb = 'tagged you';
    else if (/attach/.test(verbRaw)) verb = tagged ? 'tagged you on a file' : 'added a file';
    else verb = tagged ? 'tagged you in a comment' : 'commented';
    let where = '';
    const rest = t.slice(m.index + m[0].length);
    const w = rest.match(/^\s*(?:on|to|in)?\s*["“']?([^:“”"']{3,70})/);
    if (w) {
      where = normalize(w[1])
        .replace(/^(?:a\s+comment\s+on|the\s+card|this\s+card|card|comment\s+on|a\s+comment\s+in)\s+/i, '')
        .replace(/\s+in\s+list\b.*$/i, '')
        .replace(/\s+on\s+board\b.*$/i, '')
        .replace(/\s+\d+\s*(hours?|minutes?|days?|weeks?)\s+ago.*$/i, '')
        .trim();
    }
    return { actor: actor, verb: verb, where: where };
  }

  /* Names / handles seen inside a matched item — used to answer "who?" */
  function peopleIn(text, names) {
    const found = [];
    (names || []).forEach((n) => {
      const nn = normalize(n);
      if (nn && text.toLowerCase().indexOf(nn.toLowerCase()) !== -1) found.push(nn);
    });
    const handles = text.match(/@[a-z0-9][a-z0-9._-]{1,30}/gi) || [];
    handles.forEach((h) => found.push(h.replace(/[^@a-z0-9._-]/gi, '').trim()));
    const from = text.match(/\b(?:from|by|assigned to|assignee|owner)[:\s]+([A-Z][\w'’.-]+(?:\s[A-Z][\w'’.-]+)?)/g) || [];
    from.forEach((f) => {
      const m = f.match(/[:\s]+([A-Z][\w'’.-]+(?:\s[A-Z][\w'’.-]+)?)$/);
      if (m) found.push(m[1]);
    });
    return found;
  }

  /* ---------- default questions ---------- */

  // @rafay covers @rafay10 too (substring), but list both so it's obvious where to edit
  const ME = ['@rafay10', '@rafay', 'Rafay', 'taxplan@dilucci.com'];
  const MY_INITIALS = ['R']; // the avatar circle that means you on a board

  const DEFAULT_RULES = [
    {
      // The one that matters: cuts a 30-item Trello notification list down to
      // just the comments that actually tag you.
      id: 'r_tagged_me',
      name: 'Who tagged me in a comment?',
      enabled: true,
      sites: ['trello.com/*', '*.atlassian.net/*', 'app.asana.com/*', 'linear.app/*', 'app.clickup.com/*'],
      initials: [],
      names: ['@rafay10', '@rafay', 'Rafay'],
      keywords: [],
      regexes: [],
      builtins: ['tagged'],
      matchAll: false
    },
    {
      id: 'r_who_messaged',
      name: 'Who messaged me?',
      enabled: false,
      matchMembers: true,
      sites: ['mail.google.com/*', 'app.slack.com/*', '*.slack.com/*', 'teams.microsoft.com/*', 'outlook.*/*'],
      initials: [],
      names: ME,
      keywords: [],
      regexes: [],
      builtins: ['messages', 'mentions'],
      matchAll: false
    },
    {
      id: 'r_my_cards',
      name: 'Which cards am I on?',
      enabled: false, // membership is not the same as being tagged — off by default
      matchMembers: true, // this one IS about the avatar on the card
      sites: ['trello.com/*', '*.atlassian.net/*', 'app.clickup.com/*', 'linear.app/*'],
      initials: MY_INITIALS,
      names: ME,
      keywords: [],
      regexes: [],
      builtins: [],
      matchAll: false
    },
    {
      id: 'r_my_tasks',
      name: 'What tasks are assigned to me?',
      enabled: false,
      sites: ['app.asana.com/*', 'linear.app/*', 'notion.so/*', 'mail.google.com/*'],
      initials: MY_INITIALS,
      names: ME,
      keywords: [],
      regexes: [],
      builtins: ['assignments'],
      matchAll: true
    },
    {
      id: 'r_new_for_me',
      name: 'Anything new assigned to or mentioning me?',
      enabled: false,
      sites: ['*'],
      initials: [],
      names: ME,
      keywords: [],
      regexes: [],
      builtins: [],
      matchAll: false
    },
    {
      id: 'r_new_docs',
      name: 'Any new documents uploaded?',
      enabled: false,
      sites: ['drive.google.com/*', 'dropbox.com/*', '*.sharepoint.com/*', 'app.box.com/*'],
      names: [],
      keywords: ['uploaded', 'attachment', 'new file'],
      regexes: [],
      builtins: ['documents'],
      matchAll: false
    },
    {
      id: 'r_client_calendar',
      name: 'Anything on the calendar for a client?',
      enabled: false,
      sites: ['calendar.google.com/*'],
      names: [],
      keywords: ['consult', 'call', 'meeting', 'review'],
      regexes: [],
      builtins: [],
      matchAll: false
    },
    {
      id: 'r_deadlines',
      name: 'Any deadlines mentioned?',
      enabled: false,
      sites: ['*'],
      names: [],
      keywords: [],
      regexes: [],
      builtins: ['deadlines', 'dates'],
      matchAll: false
    }
  ];

  /* ---------- helpers ---------- */

  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function normalize(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  function urlKey(url) {
    try {
      const u = new URL(url);
      return u.origin + u.pathname;
    } catch (e) {
      return String(url || '');
    }
  }

  // "calendar.google.com/*", "*://drive.google.com/*", "*acme*", "*"
  function globToRegex(glob) {
    const g = normalize(glob);
    if (!g || g === '*') return /.*/;
    const esc = g.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*');
    // if the pattern has no scheme and doesn't start with a wildcard, allow any scheme prefix
    const needsSchemePrefix = !/^\.\*/.test(esc) && !/:\\\/\\\//.test(esc) && !/^https?/.test(g);
    return new RegExp('^' + (needsSchemePrefix ? '(https?|file|chrome-extension)://' : '') + esc + '$', 'i');
  }

  function siteMatches(rule, url) {
    const sites = (rule.sites && rule.sites.length) ? rule.sites : ['*'];
    return sites.some((s) => {
      try {
        return globToRegex(s).test(url);
      } catch (e) {
        return false;
      }
    });
  }

  function safeRegex(src) {
    try {
      return new RegExp(src, 'i');
    } catch (e) {
      return null;
    }
  }

  /* ---------- page extraction (injected into the tab) ---------- */
  /* Must be fully self-contained: no closure over anything above. */

  function extractPage() {
    const SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, CANVAS: 1, HEAD: 1 };
    const BLOCKISH = /^(block|flex|grid|list-item|table|table-row|table-cell|flow-root)$/;

    function isHidden(el) {
      try {
        const cs = getComputedStyle(el);
        return cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0';
      } catch (e) {
        return false;
      }
    }

    function nearestBlock(node) {
      let el = node.parentElement;
      while (el && el !== document.body) {
        let d = 'inline';
        try { d = getComputedStyle(el).display; } catch (e) {}
        if (BLOCKISH.test(d)) return el;
        el = el.parentElement;
      }
      return document.body;
    }

    const map = new Map();
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, null);
    let n;
    let guard = 0;
    while ((n = walker.nextNode()) && guard++ < 60000) {
      if (!n.nodeValue || !n.nodeValue.trim()) continue;
      const p = n.parentElement;
      if (!p || SKIP[p.tagName]) continue;
      if (isHidden(p)) continue;
      const block = nearestBlock(n);
      const prev = map.get(block) || '';
      if (prev.length > 2000) continue;
      map.set(block, prev ? prev + ' ' + n.nodeValue.trim() : n.nodeValue.trim());
    }

    const blocks = [];
    map.forEach((text, el) => {
      const t = text.replace(/\s+/g, ' ').trim();
      if (!t) return;
      let href = '';
      try {
        const a = el.tagName === 'A' ? el : el.querySelector('a[href]') || el.closest('a[href]');
        if (a) href = a.href;
      } catch (e) {}
      blocks.push({ text: t, href: href, tag: el.tagName });
    });

    const links = [];
    try {
      document.querySelectorAll('a[href]').forEach((a) => {
        if (links.length > 3000) return;
        links.push({ text: (a.textContent || a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(), href: a.href, tag: 'A' });
      });
    } catch (e) {}

    // aria-labels often carry the real content on apps like Google Calendar
    const labels = [];
    try {
      document.querySelectorAll('[aria-label]').forEach((el) => {
        if (labels.length > 1500) return;
        const t = (el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        if (t.length > 3) labels.push({ text: t, href: '', tag: el.tagName });
      });
    } catch (e) {}

    /* Who is attached to a card/row? On board apps (Trello, Jira, Asana) the
       person is only an avatar circle — the real name lives in title / alt /
       aria-label, and the visible text is just their initials. */
    function memberTokens(root) {
      const out = [];
      const push = (v) => {
        const t = (v || '').replace(/\s+/g, ' ').trim();
        if (t && t.length <= 80 && out.indexOf(t) === -1) out.push(t);
      };
      try {
        push(root.getAttribute && root.getAttribute('title'));
        push(root.getAttribute && root.getAttribute('alt'));
        root.querySelectorAll('[title],[alt],[aria-label]').forEach((el) => {
          if (out.length > 16) return;
          push(el.getAttribute('title'));
          push(el.getAttribute('alt'));
          push(el.getAttribute('aria-label'));
        });
        root.querySelectorAll('*').forEach((el) => {
          if (out.length > 28) return;
          if (el.children.length) return;
          const t = (el.textContent || '').trim();
          if (/^[A-Za-z]{1,3}$/.test(t)) push(t.toUpperCase());
        });
      } catch (e) {}
      return out;
    }

    /* When did this row happen? Trello shows "2 hours ago" / "yesterday at 4:15 PM",
       and usually carries a real timestamp in a datetime or title attribute. */
    function parseWhen(el, text) {
      const now = Date.now();
      const sane = (p) => (!isNaN(p) && p > now - 3.15e11 && p < now + 3.15e10) ? p : 0;
      try {
        const selfDt = el.getAttribute && el.getAttribute('datetime');
        if (selfDt && sane(Date.parse(selfDt))) return Date.parse(selfDt);
        const t = el.querySelector && el.querySelector('[datetime]');
        const dt = t && t.getAttribute('datetime');
        if (dt && sane(Date.parse(dt))) return Date.parse(dt);
      } catch (e) {}
      try {
        const cands = el.querySelectorAll ? el.querySelectorAll('[title]') : [];
        for (let i = 0; i < cands.length && i < 12; i++) {
          const v = (cands[i].getAttribute('title') || '').replace(/\s+at\s+/i, ' ').trim();
          if (v.length < 6 || v.length > 60 || !/\d/.test(v) || !/[a-z]/i.test(v)) continue;
          const p = sane(Date.parse(v));
          if (p) return p;
        }
      } catch (e) {}
      const low = (text || '').toLowerCase();
      let m;
      if (/\bjust now\b|\bseconds ago\b|\bmoments ago\b/.test(low)) return now;
      if ((m = low.match(/\b(a|an|\d{1,3})\s*(minute|min|hour|hr|day|week|month)s?\s+ago\b/))) {
        const n = (m[1] === 'a' || m[1] === 'an') ? 1 : parseInt(m[1], 10);
        const u = m[2];
        const ms = u.indexOf('min') === 0 ? 6e4 : u[0] === 'h' ? 36e5 : u[0] === 'd' ? 864e5 : u[0] === 'w' ? 6048e5 : 2592e6;
        return now - n * ms;
      }
      if (/\byesterday\b/.test(low)) { const d = new Date(); d.setDate(d.getDate() - 1); d.setHours(12, 0, 0, 0); return d.getTime(); }
      if (/\btoday\b/.test(low)) { const d = new Date(); d.setHours(9, 0, 0, 0); return d.getTime(); }
      if ((m = (text || '').match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:\s+at\s+(\d{1,2}:\d{2}\s*(?:AM|PM)?))?/i))) {
        const y = new Date().getFullYear();
        let p = Date.parse(m[1] + ' ' + m[2] + ', ' + y + (m[3] ? ' ' + m[3] : ''));
        if (!isNaN(p) && p > now + 2592e6) p -= 3.156e10; // a "Dec 20" seen in January
        if (sane(p)) return p;
      }
      return 0;
    }

    /* Card / row sized units, so a title and the avatars on it stay together. */
    const units = [];
    try {
      const sel = 'a[href], li, [role="listitem"], [role="article"], [role="row"], [role="option"],' +
        '[data-testid*="card"], [data-testid*="tile"], [data-testid*="row"],' +
        '[data-testid*="notification"], [data-testid*="comment"], [data-testid*="activity"],' +
        '[data-testid*="feed"], [data-testid*="item"], [data-testid*="mention"],' +
        '[class*="card"], [class*="Card"], [class*="list-card"],' +
        '[class*="notification"], [class*="comment"], [class*="activity"]';
      const seenUnit = new Set();
      document.querySelectorAll(sel).forEach((el) => {
        if (units.length > 900) return;
        if (isHidden(el)) return;
        const raw = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (raw.length < 3 || raw.length > 1200) return;
        const key = raw.slice(0, 200);
        if (seenUnit.has(key)) return;
        seenUnit.add(key);
        let href = '';
        try {
          const a = el.tagName === 'A' ? el : el.querySelector('a[href]');
          if (a) href = a.href;
        } catch (e) {}
        units.push({
          text: raw.slice(0, 400), href: href, tag: el.tagName,
          members: memberTokens(el), when: parseWhen(el, raw)
        });
      });
    } catch (e) {}

    return {
      url: location.href,
      title: document.title,
      scannedAt: Date.now(),
      blocks: blocks,
      links: links,
      labels: labels,
      units: units
    };
  }

  /* ---------- matching ---------- */

  function candidateItems(page) {
    const out = [];
    const seen = new Set();
    const push = (it, source) => {
      const text = normalize(it.text);
      if (!text && !it.href) return;
      const key = (text || '') + '|' + (it.href || '');
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        text: text, href: it.href || '', tag: it.tag || '',
        source: source, members: it.members || [], when: it.when || 0
      });
    };
    // cards/rows first: they carry the avatars, so "assigned to me" resolves there
    (page.units || []).forEach((u) => push(u, 'card'));
    (page.blocks || []).forEach((b) => push(b, 'text'));
    (page.links || []).forEach((l) => push(l, 'link'));
    (page.labels || []).forEach((l) => push(l, 'label'));
    return out;
  }

  /* distinct people/avatar tokens on a page — powers the "Who's on this page?" helper */
  function pageMembers(page) {
    const counts = new Map();
    (page.units || []).forEach((u) => {
      (u.members || []).forEach((m) => {
        const t = normalize(m);
        if (!t) return;
        counts.set(t, (counts.get(t) || 0) + 1);
      });
    });
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map((e) => ({ token: e[0], n: e[1] }));
  }

  function ruleHits(rule, item) {
    const members = item.members || [];
    /* Two separate haystacks, and this distinction matters a lot:
       - what the row actually SAYS (text + link)
       - who is ATTACHED to it (avatar tooltips, member chips)
       Being a member of a card is not the same as being tagged in its comments,
       so a rule only searches the member tooltips if it opts in. */
    const textHay = (item.text + ' ' + (item.href || '')).toLowerCase();
    const memberHay = members.join(' ; ').toLowerCase();
    const hay = rule.matchMembers ? (textHay + ' ' + memberHay) : textHay;
    const reasons = [];
    const inits = (rule.initials || []).map((k) => normalize(k)).filter(Boolean);
    const nms = (rule.names || []).map((k) => normalize(k)).filter(Boolean);
    const kws = (rule.keywords || []).map((k) => normalize(k)).filter(Boolean);
    const res = (rule.regexes || []).map(safeRegex).filter(Boolean);
    const bis = (rule.builtins || []).filter((b) => BUILTINS[b]);

    // avatar initials: exact match against this card's member tokens only,
    // never a substring of body text (otherwise "R" would match everything)
    const memberSet = members.map((m) => normalize(m).toLowerCase());
    inits.forEach((i) => {
      const t = i.toLowerCase();
      if (memberSet.indexOf(t) !== -1) reasons.push('avatar ' + i.toUpperCase());
    });
    nms.forEach((n) => { if (hay.indexOf(n.toLowerCase()) !== -1) reasons.push(n); });
    kws.forEach((k) => { if (hay.indexOf(k.toLowerCase()) !== -1) reasons.push(k); });
    res.forEach((r, i) => { if (r.test(item.text) || (item.href && r.test(item.href))) reasons.push('/' + rule.regexes[i] + '/'); });
    bis.forEach((b) => { if (BUILTINS[b].test(item)) reasons.push(BUILTINS[b].label); });

    const groups = [inits.length, nms.length, kws.length, res.length, bis.length].filter((c) => c > 0).length;
    if (groups === 0) return null; // rule has no criteria — matches nothing
    if (!reasons.length) return null;

    if (rule.matchAll) {
      // "me" can be proved by either an avatar or a name — those are one condition
      const meGroups = inits.length + nms.length;
      const meOk = !meGroups ||
        inits.some((i) => memberSet.indexOf(i.toLowerCase()) !== -1) ||
        nms.some((n) => hay.indexOf(n.toLowerCase()) !== -1);
      const nmOk = meOk;
      const kwOk = !kws.length || kws.every((k) => hay.indexOf(k.toLowerCase()) !== -1);
      const reOk = !res.length || res.every((r) => r.test(item.text) || (item.href && r.test(item.href)));
      const biOk = !bis.length || bis.every((b) => BUILTINS[b].test(item));
      if (!(nmOk && kwOk && reOk && biOk)) return null;
    }
    return reasons;
  }

  /* time windows */
  /* ================= whose day is it =================
     Every date boundary here used to be the machine's own midnight. He works from
     Pakistan for a firm on US Central time, so "Today" rolled over about eleven
     hours before the firm's day did: at 00:05 in Karachi it is still early
     afternoon of the previous day in Dallas, and the panel would show nothing.
     Trello due dates read a day late for the same reason.

     So the business day is what counts, in a named zone rather than a fixed
     offset — "CST" is actually CDT for most of the tax year, and America/Chicago
     handles that switch by itself. */
  const BIZ_ZONE_DEFAULT = 'America/Chicago';
  let BIZ_ZONE = BIZ_ZONE_DEFAULT;

  function setZone(tz) {
    if (!tz) return BIZ_ZONE;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });   // throws if unknown
      BIZ_ZONE = tz;
    } catch (e) { /* keep the one that works */ }
    return BIZ_ZONE;
  }

  function getZone() { return BIZ_ZONE; }

  /* how far that zone is from UTC at a given instant, daylight saving included */
  function zoneOffsetMs(ms, tz) {
    try {
      const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: tz || BIZ_ZONE, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
      const p = {};
      dtf.formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
      const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
      /* the formatted parts have no milliseconds, so compare against a whole
         second — otherwise the offset carries the leftover fraction, and a day
         boundary computed from it lands a few milliseconds off midnight. That
         made "Yesterday" one millisecond long. */
      return asUTC - Math.floor(ms / 1000) * 1000;
    } catch (e) {
      return -new Date(ms).getTimezoneOffset() * 60000;   // fall back to this machine
    }
  }

  /* midnight of that instant's day, in the business zone, as a real timestamp */
  function startOfDayIn(ms, tz) {
    const at = ms == null ? Date.now() : ms;
    const off = zoneOffsetMs(at, tz);
    const floor = Math.floor((at + off) / 864e5) * 864e5;
    let guess = floor - off;
    /* on the two days a year the clocks move, the offset at midnight differs
       from the offset now — ask again at the answer */
    const off2 = zoneOffsetMs(guess, tz);
    if (off2 !== off) guess = floor - off2;
    return guess;
  }

  /* the calendar date in that zone, for comparing days without arithmetic */
  function dayKeyIn(ms, tz) {
    try {
      const dtf = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz || BIZ_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
      });
      return dtf.format(new Date(ms));            // YYYY-MM-DD
    } catch (e) {
      const d = new Date(ms);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
        '-' + String(d.getDate()).padStart(2, '0');
    }
  }

  /* whole days between two instants, counted in the business zone */
  function daysApartIn(a, b, tz) {
    return Math.round(
      (Date.parse(dayKeyIn(a, tz) + 'T00:00:00Z') - Date.parse(dayKeyIn(b, tz) + 'T00:00:00Z')) / 864e5
    );
  }

  /* the day picked in the filter popover's date input ("YYYY-MM-DD"), or
     null when no custom date is active — read by the 'custom' range below */
  let CUSTOM_DATE_KEY = null;

  function setCustomDate(dateKey) {
    CUSTOM_DATE_KEY = dateKey || null;
  }

  function getCustomDate() {
    return CUSTOM_DATE_KEY;
  }

  const RANGES = [
    { mode: 'today', label: 'Today',
      since: () => startOfDayIn(Date.now()),
      until: () => 0 },
    { mode: 'yesterday', label: 'Yesterday',
      since: () => startOfDayIn(startOfDayIn(Date.now()) - 1),
      until: () => startOfDayIn(Date.now()) },
    { mode: '7d', label: 'Last 7 days', since: () => Date.now() - 7 * 864e5, until: () => 0 },
    { mode: '24h', label: 'Last 24 hours', since: () => Date.now() - 864e5, until: () => 0 },
    { mode: 'any', label: 'Any time', since: () => 0, until: () => 0 },
    { mode: 'custom', label: 'Custom date',
      since: () => CUSTOM_DATE_KEY ? startOfDayIn(Date.parse(CUSTOM_DATE_KEY + 'T12:00:00Z')) : 0,
      until: () => CUSTOM_DATE_KEY ? startOfDayIn(Date.parse(CUSTOM_DATE_KEY + 'T12:00:00Z')) + 864e5 : 0 }
  ];

  /* how the custom date should actually read once picked, e.g. "Aug 25" —
     separate from RANGES[].label (kept a plain string there) since callers
     treat that field as static text, not something to invoke */
  function customDateLabel() {
    if (!CUSTOM_DATE_KEY) return 'Custom date';
    try {
      return new Date(CUSTOM_DATE_KEY + 'T12:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch (e) {
      return CUSTOM_DATE_KEY;
    }
  }

  const UI_RANGES = ['today', 'yesterday', '7d'];

  /* Board / card prefixes you work in. Matched against the card name, the list
     and the board, so "[QTM2] Gary Warner" lands in QTM either way. */
  const GROUPS = [
    { id: 'all', label: 'All', re: null },
    { id: 'qtm', label: 'QTM', re: /\b(qtm|utm)\s*\d*\b/i },
    { id: 'tpd', label: 'TPD', re: /\btpd\s*\d*\b/i },
    { id: 'tpr', label: 'TPR', re: /\btpr\s*\d*\b/i }
  ];

  function groupFor(id) {
    return GROUPS.filter((g) => g.id === id)[0] || GROUPS[0];
  }

  function inGroup(item, groupId) {
    const g = groupFor(groupId);
    if (!g.re) return true;
    const hay = [item.cardName, item.listName, item.boardName, item.text].filter(Boolean).join(' ');
    return g.re.test(hay);
  }

  function rangeFor(mode) {
    return RANGES.filter((r) => r.mode === mode)[0] || RANGES[0];
  }

  /* results: [{ rule, items:[{text, href, hash, reasons, isNew, firstSeen}], newCount, total }] */
  function scan(page, rules, snapshots, opts) {
    const sinceMs = (opts && opts.sinceMs) || 0;
    const untilMs = (opts && opts.untilMs) || 0;
    const results = [];
    (rules || []).forEach((rule) => {
      if (!rule.enabled) return;
      if (!siteMatches(rule, page.url)) return;

      const items = candidateItems(page);
      const snapKey = rule.id + '|' + urlKey(page.url);
      const snap = (snapshots && snapshots[snapKey]) || { hashes: {}, lastChecked: 0 };
      const out = [];
      const dedupe = new Set();
      const peopleCount = new Map();

      // a bare name/initial on its own (an avatar's own label) is not an answer
      const bareTokens = new Set(
        (rule.names || []).concat(rule.initials || [])
          .map((t) => normalize(t).toLowerCase()).filter(Boolean)
      );
      const isBareToken = (item) => {
        const t = normalize(item.text).toLowerCase();
        if (!t || t.length > 40) return false;
        if (bareTokens.has(t)) return true;
        // "Rafay (@rafay)" style avatar tooltips with nothing else in them
        return Array.from(bareTokens).some((tok) =>
          tok.length > 2 && t.replace(/[()@,\-–—:;|]/g, ' ').replace(/\s+/g, ' ').trim()
            .split(' ').every((w) => tok.indexOf(w) !== -1 || w.length < 2));
      };

      for (const item of items) {
        if (item.source !== 'card' && isBareToken(item)) continue;
        const reasons = ruleHits(rule, item);
        if (!reasons) continue;
        const snippet = item.text.length > MAX_SNIPPET ? item.text.slice(0, MAX_SNIPPET) + '…' : item.text;
        const h = hash(normalize(snippet) + '|' + (item.href || ''));
        if (dedupe.has(h)) continue;
        dedupe.add(h);
        const perItem = new Map(); // count each person at most once per item
        peopleIn(item.text + ' ' + (item.members || []).join(' ; '), rule.names).forEach((p) => {
          const key = p.replace(/^@/, '').toLowerCase();
          const cur = perItem.get(key);
          // prefer a plain name label over a bare @handle for the same person
          if (!cur || (cur[0] === '@' && p[0] !== '@')) perItem.set(key, p);
        });
        perItem.forEach((label, key) => {
          if (!peopleCount.has(key)) peopleCount.set(key, { label: label, n: 0 });
          const rec = peopleCount.get(key);
          if (rec.label[0] === '@' && label[0] !== '@') rec.label = label;
          rec.n++;
        });
        const sum = mentionSummary(item.text, (rule.names || []).concat(rule.initials || []));
        out.push({
          text: snippet || item.href,
          actor: sum ? sum.actor : '',
          cardName: sum ? sum.where : '',
          href: item.href,
          source: item.source,
          headline: sum
            ? sum.actor + ' ' + sum.verb + (sum.where ? ' on “' + sum.where + '”' : '')
            : '',
          hash: h,
          reasons: Array.from(new Set(reasons)).slice(0, 4),
          when: item.when || 0,
          isNew: !Object.prototype.hasOwnProperty.call(snap.hashes, h),
          firstSeen: snap.hashes[h] || null
        });
        if (out.length >= MAX_ITEMS_PER_RULE) break;
      }

      /* keep only what happened inside the chosen window. If the page exposes no
         timestamps at all we can't filter, so show everything and say so. */
      /* Only ever hide something we can positively date as old. An item whose
         timestamp we couldn't read is kept — hiding those was silently dropping
         real mentions. */
      let kept = out;
      let hiddenOld = 0;
      let undatedPage = false;
      if (sinceMs || untilMs) {
        kept = out.filter((i) => !i.when || ((!sinceMs || i.when >= sinceMs) && (!untilMs || i.when < untilMs)));
        hiddenOld = out.length - kept.length;
        undatedPage = kept.length > 0 && kept.every((i) => !i.when);
      }

      kept.sort((a, b) =>
        ((b.isNew ? 1 : 0) - (a.isNew ? 1 : 0)) || ((b.when || 0) - (a.when || 0)));

      const people = Array.from(peopleCount.values())
        .sort((a, b) => b.n - a.n)
        .slice(0, 10)
        .map((p) => p.label + (p.n > 1 ? ' ×' + p.n : ''));
      results.push({
        rule: rule,
        snapKey: snapKey,
        items: kept,
        people: people,
        newCount: kept.filter((i) => i.isNew).length,
        total: kept.length,
        hiddenOld: hiddenOld,
        undatedPage: undatedPage,
        matchedBeforeDateFilter: out.length,
        neverChecked: !snap.lastChecked,
        lastChecked: snap.lastChecked || 0
      });
    });
    return results;
  }

  /* ---------- Trello: ask Trello itself, instead of reading the page ----------
     A board page has no comment text in it, so scraping can never answer
     "who tagged me". This runs inside the Trello tab (same origin, your existing
     login) and reads your own notification list — the same call Trello's own web
     app makes. Read-only, and it never leaves trello.com. */

  /* The same shaping, for the background worker, which can sometimes reach Trello
     without a tab at all. The injected copy below has to repeat it inline because
     injected code has no access to this file — _t33 asserts the two agree. */
  const NOTIF_URL = 'https://trello.com/1/members/me/notifications';
  /* card=true asks Trello to attach the card itself, so the due date arrives with
     the mentions rather than costing a request each. */
  const NOTIF_QS = '?limit=100&read_filter=all&filter=mentionedOnCard,commentCard' +
    '&card=true&card_fields=name,shortLink,due,dueComplete,idList';

  function pickDue(n, key) {
    if (n && n.card && typeof n.card[key] !== 'undefined') return n.card[key];
    if (n && n.data && n.data.card && typeof n.data.card[key] !== 'undefined') return n.data.card[key];
    return undefined;
  }

  /* Just the due date, for a card whose notification did not carry one. */
  async function fetchCardDue(cardId) {
    try {
      const res = await fetch(
        'https://trello.com/1/cards/' + encodeURIComponent(cardId) + '?fields=due,dueComplete',
        { credentials: 'include', headers: { Accept: 'application/json' } }
      );
      if (!res.ok) return { ok: false, status: res.status };
      const c = await res.json();
      return { ok: true, due: c.due || null, dueComplete: !!c.dueComplete };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /* Same idea as fetchCardDue, plus the card's real name — for filing a
     board card with the actual client/card title rather than whatever (or
     nothing) the notification payload happened to carry. */
  async function fetchCardDetails(cardId) {
    try {
      const res = await fetch(
        'https://trello.com/1/cards/' + encodeURIComponent(cardId) + '?fields=name,due,dueComplete',
        { credentials: 'include', headers: { Accept: 'application/json' } }
      );
      if (!res.ok) return { ok: false, status: res.status };
      const c = await res.json();
      return { ok: true, name: c.name || '', due: c.due || null, dueComplete: !!c.dueComplete };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /* How a deadline should read at a glance. Whole calendar days, not 24-hour
     blocks: something due at 9am tomorrow is "tomorrow", not "in 15 hours". */
  function dueLabel(due, dueComplete, now) {
    if (!due) return null;
    const then = new Date(due);
    if (isNaN(then.getTime())) return null;
    const ref = now ? new Date(now) : new Date();
    /* counted in the business zone: a card due 6 Aug in Dallas must not read as
       the 7th because the reader happens to be in Karachi */
    const days = daysApartIn(then.getTime(), ref.getTime());
    let date = '';
    try {
      date = then.toLocaleDateString('en-US', {
        weekday: 'short', day: 'numeric', month: 'short', timeZone: BIZ_ZONE
      });
    } catch (e) {
      date = then.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    }

    if (dueComplete) return { text: 'Due ' + date, tone: 'done', days: days, done: true };
    if (days < 0) {
      const n = Math.abs(days);
      return { text: n === 1 ? 'Due yesterday' : n + ' days overdue', tone: 'overdue', days: days };
    }
    if (days === 0) return { text: 'Due today', tone: 'today', days: 0 };
    if (days === 1) return { text: 'Due tomorrow', tone: 'soon', days: 1 };
    if (days <= 6) return { text: 'Due ' + date, tone: 'soon', days: days };
    return { text: 'Due ' + date, tone: 'later', days: days };
  }

  /* ---------- what a comment looks like on screen ----------
     Trello stores an inline link as [text](url "smartCard-inline"), so a comment
     with one Canopy link arrives as the whole URL twice plus the marker — which
     is most of what filled the panel in his screenshot. This is for DISPLAY only:
     item.text keeps the original, because that is what is matched against the
     real comment when posting a reaction. */
  function shortUrl(url) {
    try {
      const u = new URL(url);
      const bits = u.pathname.split('/').filter(Boolean);
      const hash = (u.hash || '').split('/').filter(Boolean);
      const last = (hash.length ? hash : bits).slice(-1)[0] || '';
      const host = u.host.replace(/^www\./, '');
      return last ? host + '/…/' + decodeURIComponent(last) : host;
    } catch (e) {
      return String(url || '').slice(0, 48);
    }
  }

  function tidyCommentText(text) {
    let t = String(text == null ? '' : text);
    /* [label](url "smartCard-inline") and [label](url) */
    t = t.replace(/\[([^\]]*)\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/g,
      function (whole, label, url) {
        const lab = String(label || '').trim();
        if (!lab || lab === url) return shortUrl(url);
        return lab;
      });
    /* the same link left over twice in a row. Requires a word character up
       front so a punctuation-only token is left alone — "** **" (a closing
       markdown-bold marker right before the next opening one) is not "the
       same word twice", and collapsing it broke the pairing for every bold
       segment after the first. */
    t = t.replace(/(\w\S*)(\s+\1\b)+/g, '$1');
    /* A bare URL is fine; 70 characters of one is not. 45 is chosen so an ordinary
       Trello card link (about 35) is left alone while a Canopy docs link (about 57)
       is shortened — the first threshold I picked was 60 and missed it. */
    t = t.replace(/https?:\/\/\S{45,}/g, function (u) { return shortUrl(u); });
    return t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  function shapeNotifications(json) {
    return (Array.isArray(json) ? json : []).map(function (n) {
      return {
        id: n.id,
        type: n.type,
        unread: !!n.unread,
        date: n.date,
        actor: (n.memberCreator && (n.memberCreator.fullName || n.memberCreator.username)) || 'Someone',
        actorUser: (n.memberCreator && n.memberCreator.username) || '',
        boardId: (n.data && n.data.board && n.data.board.id) || '',
        cardName: (n.data && n.data.card && n.data.card.name) || '',
        cardId: (n.data && n.data.card && n.data.card.id) || '',
        shortLink: (n.data && n.data.card && n.data.card.shortLink) || '',
        boardName: (n.data && n.data.board && n.data.board.name) || '',
        listName: (n.data && n.data.list && n.data.list.name) || '',
        text: (n.data && n.data.text) || '',
        actionId: (n.data && n.data.action && n.data.action.id) || '',
        /* undefined means "not asked yet", null means "this card has no due date".
           The difference matters: one is worth a lookup, the other is an answer. */
        due: pickDue(n, 'due'),
        dueComplete: pickDue(n, 'dueComplete')
      };
    });
  }

  /* Your mentions, from wherever we can get them — so the panel works on any page,
     not only while you are looking at Trello:
       1. the Trello tab you are on, or any Trello tab you have open (proven route)
       2. failing that, straight from here, which needs no tab at all             */
  async function notificationsAnywhere(preferTabId) {
    const tryTab = async (id) => {
      try {
        const got = await chrome.scripting.executeScript({
          target: { tabId: id, allFrames: false }, world: 'MAIN', func: fetchTrelloNotifications
        });
        const r = got && got[0] && got[0].result;
        if (r && r.ok) { r.how = 'tab'; return r; }
      } catch (e) {}
      return null;
    };

    if (preferTabId) {
      const r = await tryTab(preferTabId);
      if (r) return r;
    }
    try {
      const tabs = await chrome.tabs.query({ url: ['*://trello.com/*', '*://*.trello.com/*'] });
      for (const t of (tabs || [])) {
        if (!t.id || t.id === preferTabId) continue;
        const r = await tryTab(t.id);
        if (r) return r;
      }
    } catch (e) {}

    /* no usable tab: ask Trello directly. Whether Chrome attaches your session
       cookie to an extension request depends on how Trello marks it, so this is
       an attempt with an honest failure, not an assumption. */
    try {
      const res = await fetch(NOTIF_URL + NOTIF_QS, {
        credentials: 'include', headers: { Accept: 'application/json' }
      });
      if (!res.ok) {
        return { ok: false, status: res.status, how: 'direct',
          error: res.status === 401 || res.status === 403
            ? 'Trello would not answer without a tab open — open Trello once and leave it open'
            : 'Trello said no (' + res.status + ')' };
      }
      const json = await res.json();
      if (!Array.isArray(json)) return { ok: false, error: 'unexpected response from Trello', how: 'direct' };
      return { ok: true, items: shapeNotifications(json), how: 'direct' };
    } catch (e) {
      return { ok: false, how: 'direct', error: 'Could not reach Trello — open a Trello tab and try again.' };
    }
  }

  function fetchTrelloNotifications() {
    const shape = (n) => ({
      id: n.id,
      type: n.type,
      unread: !!n.unread,
      date: n.date,
      actor: (n.memberCreator && (n.memberCreator.fullName || n.memberCreator.username)) || 'Someone',
      actorUser: (n.memberCreator && n.memberCreator.username) || '',
      boardId: (n.data && n.data.board && n.data.board.id) || '',
      cardName: (n.data && n.data.card && n.data.card.name) || '',
      cardId: (n.data && n.data.card && n.data.card.id) || '',
      shortLink: (n.data && n.data.card && n.data.card.shortLink) || '',
      boardName: (n.data && n.data.board && n.data.board.name) || '',
      listName: (n.data && n.data.list && n.data.list.name) || '',
      text: (n.data && n.data.text) || '',
      // occasionally Trello hands us the comment itself; saves a lookup when it does
      actionId: (n.data && n.data.action && n.data.action.id) || ''
    });
    const get = (qs) => fetch('https://trello.com/1/members/me/notifications' + qs, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    });
    return (async () => {
      try {
        let res = await get('?limit=100&read_filter=all&filter=mentionedOnCard,commentCard');
        if (!res.ok) res = await get('?limit=100&read_filter=all');
        if (!res.ok) return { ok: false, status: res.status };
        let json = await res.json();
        if (!Array.isArray(json)) return { ok: false, error: 'unexpected response' };
        if (!json.length) {
          const res2 = await get('?limit=100&read_filter=all');
          if (res2.ok) {
            const j2 = await res2.json();
            if (Array.isArray(j2)) json = j2;
          }
        }
        return { ok: true, items: json.map(shape), me: null };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    })();
  }

  /* Post a comment back to a card. Runs inside the Trello tab as the page, so it
     uses the login you already have. Trello requires the dsc double-submit token
     on writes when you authenticate by cookie, which is readable from the page. */
  /* ---------- Done, remembered by Trello ----------
     "Whenever I re-upload the extension I have to click Done on the same cards
     again and again."

     Because uninstalling an extension deletes everything it stored, so the record
     of what he had dealt with went with it. The fix is not a better cache — it is
     to stop keeping the truth here. Trello already tracks whether a notification
     is read, so Done marks it read THERE. That survives reinstalling this, moving
     to another machine, and a new Chrome profile, and it means the Trello bell
     agrees with the panel instead of contradicting it.

     Injected, so it must reference nothing outside itself. */
  function setNotificationRead(notificationId, read) {
    return (async () => {
      try {
        if (!notificationId) return { ok: false, error: 'no notification id' };
        const m = document.cookie.match(/(?:^|;\s*)dsc=([^;]+)/);
        const dsc = m ? decodeURIComponent(m[1]) : '';
        const body = new URLSearchParams();
        body.set('unread', read ? 'false' : 'true');
        if (dsc) body.set('dsc', dsc);
        const res = await fetch(
          'https://trello.com/1/notifications/' + encodeURIComponent(notificationId),
          {
            method: 'PUT',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: body.toString()
          }
        );
        if (!res.ok) {
          let t = '';
          try { t = (await res.text()).slice(0, 200); } catch (e) {}
          return { ok: false, status: res.status, body: t, hadDsc: !!dsc };
        }
        let j = null;
        try { j = await res.json(); } catch (e) {}
        return { ok: true, unread: j ? !!j.unread : !read };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    })();
  }

  /* Tell Trello this mention is dealt with (or, on Undo, that it is not).
     Only ever touches the read flag on his own notification — it does not
     comment, move, close or change anything on the card. */
  async function rememberHandled(item, undo) {
    const id = item && item.hash && item.hash.indexOf('tn:') === 0
      ? item.hash.slice(3)
      : (item && item.notificationId) || '';
    if (!id) return { ok: false, error: 'not a Trello notification' };
    return inTrelloTab(setNotificationRead, [id, !undo], true);   // he just clicked "done" — worth opening a tab for
  }

  function handledErrorMessage(res) {
    if (!res) return 'Nothing came back from Trello.';
    if (res.error && res.error.indexOf('could not open a Trello tab') === 0) {
      return 'Marked done here, but Trello could not be told — make sure you are logged into Trello in this browser and it will catch up.';
    }
    if (res.error) return res.error;
    if (res.status === 401 || res.status === 403) return 'Trello would not accept it — reload your Trello tab.';
    return 'Trello said no (' + (res.status || '?') + ').';
  }

  function postTrelloComment(cardId, text) {
    return (async () => {
      try {
        if (!cardId) return { ok: false, error: 'no card id' };
        const m = document.cookie.match(/(?:^|;\s*)dsc=([^;]+)/);
        const dsc = m ? decodeURIComponent(m[1]) : '';
        const body = new URLSearchParams();
        body.set('text', text);
        if (dsc) body.set('dsc', dsc);
        const res = await fetch('https://trello.com/1/cards/' + encodeURIComponent(cardId) + '/actions/comments', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: body.toString()
        });
        if (!res.ok) {
          let t = '';
          try { t = (await res.text()).slice(0, 200); } catch (e) {}
          return { ok: false, status: res.status, body: t, hadDsc: !!dsc };
        }
        let j = null;
        try { j = await res.json(); } catch (e) {}
        return { ok: true, id: j && j.id };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    })();
  }

  function fetchTrelloMembers(cardId) {
    return (async () => {
      try {
        if (!cardId) return { ok: false };
        const res = await fetch('https://trello.com/1/cards/' + encodeURIComponent(cardId) +
          '/board/members?fields=fullName,username', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        if (!res.ok) return { ok: false, status: res.status };
        const j = await res.json();
        if (!Array.isArray(j)) return { ok: false };
        return { ok: true, members: j.map((m) => ({ username: m.username, fullName: m.fullName || m.username })) };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    })();
  }

  async function cardMembers(cardId) {
    const tabs = await chrome.tabs.query({ url: ['*://trello.com/*', '*://*.trello.com/*'] });
    const tab = (tabs || []).filter((t) => t.id)[0];
    if (!tab) return [];
    try {
      const got = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN', func: fetchTrelloMembers, args: [cardId]
      });
      const r = got && got[0] && got[0].result;
      return (r && r.ok && r.members) || [];
    } catch (e) {
      return [];
    }
  }

  /* everyone who has tagged you lately — a free directory, no extra request */
  function knownPeople(state) {
    const out = [];
    const seen = new Set();
    const raw = state && state.trelloRaw;
    if (raw && raw.ok) {
      (raw.items || []).forEach((n) => {
        if (!n.actorUser || seen.has(n.actorUser)) return;
        seen.add(n.actorUser);
        out.push({ username: n.actorUser, fullName: n.actor || n.actorUser });
      });
    }
    return out;
  }

  function mergePeople(a, b) {
    const out = [];
    const seen = new Set();
    (a || []).concat(b || []).forEach((p) => {
      if (!p || !p.username || seen.has(p.username.toLowerCase())) return;
      seen.add(p.username.toLowerCase());
      out.push(p);
    });
    return out;
  }

  function matchPeople(people, q) {
    const s = (q || '').toLowerCase();
    const scored = (people || []).map((p) => {
      const u = (p.username || '').toLowerCase();
      const f = (p.fullName || '').toLowerCase();
      let score = -1;
      if (!s) score = 0;
      else if (u.indexOf(s) === 0) score = 3;
      else if (f.split(' ').some((w) => w.indexOf(s) === 0)) score = 2;
      else if (u.indexOf(s) !== -1 || f.indexOf(s) !== -1) score = 1;
      return { p: p, score: score };
    }).filter((x) => x.score >= 0);
    scored.sort((x, y) => y.score - x.score || x.p.username.localeCompare(y.p.username));
    return scored.map((x) => x.p).slice(0, 6);
  }

  function replyErrorMessage(r) {
    if (!r) return 'No answer from Trello.';
    if (r.stage === 'attach') {
      if (r.status === 401 || r.status === 403) return 'Trello refused the image — open the card and check you are still signed in.';
      if (r.status === 400 && !r.hadDsc) return 'Trello needs a fresh page — reload your Trello tab and try again.';
      if (r.status) return 'Trello would not accept the image (' + r.status + '). Nothing was sent.';
      return 'Could not upload the image: ' + (r.error || 'unknown') + '. Nothing was sent.';
    }
    if (r.status === 401 || r.status === 403) return 'Trello refused the reply — open the card and check you are still signed in.';
    if (r.status === 400 && !r.hadDsc) return 'Trello needs a fresh page — reload your Trello tab and try again.';
    if (r.status) return 'Trello said no (' + r.status + '). Your reply was not posted.';
    return 'Could not post the reply: ' + (r.error || 'unknown') + '. Nothing was sent.';
  }

  /* ---------- attaching an image to a reply ----------
     Trello comments are plain text — there is no "attach a file to this
     comment" call. Instead the image is uploaded as a card attachment first,
     the same way Trello's own UI does it, and the comment references it with
     a markdown image line so it also renders inline in the thread. */

  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

  function imageAttachError(file) {
    if (!file) return 'That is not a file.';
    if (!/^image\//.test(file.type)) return 'Only images can be attached here.';
    if (file.size > MAX_IMAGE_BYTES) {
      return 'That image is too big (' + (Math.round(file.size / 1024 / 1024 * 10) / 10) + ' MB) — 10 MB max.';
    }
    return '';
  }

  function pickImageFromTransfer(dt) {
    if (!dt || !dt.files) return null;
    for (let i = 0; i < dt.files.length; i++) {
      if (/^image\//.test(dt.files[i].type)) return dt.files[i];
    }
    return null;
  }

  function pickImageFromClipboard(cd) {
    if (!cd || !cd.items) return null;
    for (let i = 0; i < cd.items.length; i++) {
      if (cd.items[i].kind === 'file' && /^image\//.test(cd.items[i].type)) return cd.items[i].getAsFile();
    }
    return null;
  }

  /* Runs on the Trello page itself — same reason postTrelloComment does: it
     needs the page's own login and dsc token, not the extension's. */
  function uploadTrelloAttachment(cardId, file) {
    return (async () => {
      try {
        if (!cardId) return { ok: false, error: 'no card id' };
        const m = document.cookie.match(/(?:^|;\s*)dsc=([^;]+)/);
        const dsc = m ? decodeURIComponent(m[1]) : '';
        const form = new FormData();
        form.set('file', file, file.name || 'image.png');
        if (dsc) form.set('dsc', dsc);
        const res = await fetch('https://trello.com/1/cards/' + encodeURIComponent(cardId) + '/attachments', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
          body: form
        });
        if (!res.ok) {
          let t = '';
          try { t = (await res.text()).slice(0, 200); } catch (e) {}
          return { ok: false, status: res.status, body: t, hadDsc: !!dsc };
        }
        let j = null;
        try { j = await res.json(); } catch (e) {}
        return { ok: true, id: j && j.id, url: j && j.url, name: (j && j.name) || file.name };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    })();
  }

  /* send a reply from the panel, optionally with one image; opens a Trello tab
     in the background first if he doesn't already have one */
  async function replyToCard(cardId, text, file) {
    const body = normalize(text);
    if (!body && !file) return { ok: false, error: 'empty' };
    const tab = await ensureTrelloTab(true);
    if (!tab) return { ok: false, error: 'could not open a Trello tab — check you are logged into Trello in this browser' };

    let finalBody = body;
    if (file) {
      let att;
      try {
        const got = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN',
          func: uploadTrelloAttachment,
          args: [cardId, file]
        });
        att = (got && got[0] && got[0].result) || { ok: false, error: 'no result' };
      } catch (e) {
        att = { ok: false, error: String((e && e.message) || e) };
      }
      if (!att.ok) return Object.assign({ stage: 'attach' }, att);
      finalBody = finalBody ? finalBody + '\n\n![' + att.name + '](' + att.url + ')' : '![' + att.name + '](' + att.url + ')';
    }

    try {
      const got = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: postTrelloComment,
        args: [cardId, finalBody]
      });
      return (got && got[0] && got[0].result) || { ok: false, error: 'no result' };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  const QUICK_REPLIES = ['Got it, thanks', 'Yes, already delivered', 'Will do today', 'Looking at it now'];

  /* ---------- reacting to the comment ----------
     Often the honest answer to "let us know once X is updated" is an emoji, not a
     sentence. Trello reactions hang off the *comment action*, and a notification
     does not carry that id, so it is found by matching the comment text on the
     card. Then the reaction posts the same way a comment does: as the page, with
     your own login and the dsc token. */

  const REACTIONS = [
    { emoji: '👍', shortName: 'thumbsup', unified: '1f44d', label: 'Got it' },
    { emoji: '✅', shortName: 'white_check_mark', unified: '2705', label: 'Done' },
    { emoji: '👀', shortName: 'eyes', unified: '1f440', label: 'Looking at it' },
    { emoji: '🙏', shortName: 'pray', unified: '1f64f', label: 'Thanks' }
  ];

  function findCommentAction(cardId, text, actorUser) {
    return (async () => {
      try {
        if (!cardId) return { ok: false, error: 'no card id' };
        const res = await fetch('https://trello.com/1/cards/' + encodeURIComponent(cardId) +
          '/actions?filter=commentCard&limit=50&memberCreator_fields=username',
          { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        if (!res.ok) return { ok: false, status: res.status };
        const j = await res.json();
        const flat = function (s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); };
        const want = flat(text).replace(/…$/, '');
        const who = String(actorUser || '').toLowerCase();

        let best = null;
        (Array.isArray(j) ? j : []).forEach(function (a) {
          const body = flat(a && a.data && a.data.text);
          if (!body) return;
          const by = ((a.memberCreator && a.memberCreator.username) || '').toLowerCase();
          if (who && by && by !== who) return;
          // the panel truncates long comments, so compare on the shorter of the two
          const n = Math.min(body.length, want.length, 120);
          if (n < 12) return;
          if (body.slice(0, n) !== want.slice(0, n)) return;
          if (!best || (a.date || '') > (best.date || '')) best = a;
        });
        if (!best) return { ok: false, error: 'could not find that comment on the card' };
        return { ok: true, id: best.id, reactions: best.reactions || [] };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    })();
  }

  function postTrelloReaction(actionId, shortName, unified) {
    return (async () => {
      try {
        if (!actionId) return { ok: false, error: 'no comment id' };
        const m = document.cookie.match(/(?:^|;\s*)dsc=([^;]+)/);
        const dsc = m ? decodeURIComponent(m[1]) : '';
        const body = new URLSearchParams();
        body.set('shortName', shortName);
        if (unified) body.set('unified', unified);
        if (dsc) body.set('dsc', dsc);
        const res = await fetch('https://trello.com/1/actions/' + encodeURIComponent(actionId) + '/reactions', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: body.toString()
        });
        if (!res.ok) {
          let t = '';
          try { t = (await res.text()).slice(0, 200); } catch (e) {}
          // reacting twice with the same emoji is not a failure worth shouting about
          if (res.status === 409 || /already/i.test(t)) return { ok: true, already: true };
          return { ok: false, status: res.status, body: t, hadDsc: !!dsc };
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    })();
  }

  /* Every reply/reaction/lookup runs a content script inside a real Trello
     tab, riding his own session instead of a separate API key — but that
     meant the whole thing quietly did nothing if he simply didn't have
     trello.com open anywhere. Rather than surface that as a dead end, open
     one in the background and wait for it to finish loading before handing
     it back; it's reused by every call after this one, same as a tab he
     opened himself. */
  function waitForTabLoad(tabId) {
    return new Promise(function (resolve) {
      let done = false;
      const finish = function () {
        if (done) return;
        done = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      };
      const listener = function (id, info) {
        if (id === tabId && info.status === 'complete') finish();
      };
      chrome.tabs.onUpdated.addListener(listener);
      chrome.tabs.get(tabId, function (t) { if (t && t.status === 'complete') finish(); });
      setTimeout(finish, 8000);   // Trello can hang; don't block a reply on it forever
    });
  }

  /* autoOpen is opt-in: an explicit reply/react/open-card is worth a
     background tab to unblock, but the passive stuff that runs on its own
     (filing a freshly-tagged card, lazily backfilling a due date while a
     list scrolls by) should keep degrading quietly the way it always has,
     not start popping tabs open on a timer nobody asked for. */
  async function ensureTrelloTab(autoOpen) {
    const tabs = await chrome.tabs.query({ url: ['*://trello.com/*', '*://*.trello.com/*'] });
    const existing = (tabs || []).filter(function (t) { return t.id; })[0];
    if (existing || !autoOpen) return existing || null;
    let tab;
    try {
      tab = await chrome.tabs.create({ url: 'https://trello.com/', active: false });
    } catch (e) {
      return null;
    }
    if (!tab || !tab.id) return null;
    await waitForTabLoad(tab.id);
    return tab;
  }

  /* Run a reader inside whatever Trello tab is open, so his session applies.
     reactToMention grew its own copy of this; this is the shared one. */
  async function inTrelloTab(func, args, autoOpen) {
    const tab = await ensureTrelloTab(autoOpen);
    if (!tab) {
      return { ok: false, error: autoOpen
        ? 'could not open a Trello tab — check you are logged into Trello in this browser'
        : 'no Trello tab is open' };
    }
    try {
      const got = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN', func: func, args: args || []
      });
      return (got && got[0] && got[0].result) || { ok: false, error: 'no result' };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /* The due date for one card, looked up only when the mention did not carry it. */
  async function dueForCard(cardId) {
    if (!cardId) return { ok: false, error: 'no card' };
    return inTrelloTab(fetchCardDue, [cardId]);
  }

  /* Name + due date together, for filing a board card with the real thing
     rather than whatever the notification payload happened to include.
     Same "needs an open Trello tab" constraint as dueForCard — no direct-
     fetch fallback, since that path is reserved for reading notifications.
     autoOpen defaults off (fileTagCard calls this unattended, on every fresh
     tag) — the Backfill button, an explicit one-off action, opts in. */
  async function cardDetailsFor(cardId, autoOpen) {
    if (!cardId) return { ok: false, error: 'no card' };
    return inTrelloTab(fetchCardDetails, [cardId], !!autoOpen);
  }

  /* The whole card in one request — description, due, checklist progress and the
     full comment feed — what the board's "Open card" panel expands into. This is
     meant to read like the card itself, not just its comments, so it pulls
     everything Trello's own card-detail view leads with. Same "needs an open
     Trello tab" constraint as the other card-scoped lookups above. Injected, so
     it must reference nothing outside itself. */
  function fetchCardWhole(cardId) {
    return (async () => {
      try {
        const res = await fetch('https://trello.com/1/cards/' + encodeURIComponent(cardId) +
          '?fields=name,desc,due,dueComplete' +
          '&checklists=all&checklist_fields=name&checkItem_fields=name,state' +
          '&actions=commentCard&actions_limit=50&action_memberCreator_fields=username,fullName',
          { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        if (!res.ok) return { ok: false, status: res.status };
        const j = await res.json();

        const checklist = [];
        (Array.isArray(j.checklists) ? j.checklists : []).forEach(function (cl) {
          (cl.checkItems || []).forEach(function (it) {
            checklist.push({ name: String(it.name || '').replace(/\s+/g, ' ').trim(), done: it.state === 'complete' });
          });
        });

        const comments = (Array.isArray(j.actions) ? j.actions : [])
          .filter(function (a) { return a && a.type === 'commentCard'; })
          .map(function (a) {
            return {
              at: Date.parse((a && a.date) || '') || 0,
              by: ((a && a.memberCreator && a.memberCreator.username) || '').toLowerCase(),
              byName: (a && a.memberCreator && a.memberCreator.fullName) || '',
              text: String((a && a.data && a.data.text) || '').replace(/\s+/g, ' ').trim()
            };
          });

        return {
          ok: true, name: j.name || '', desc: String(j.desc || '').trim(),
          due: j.due || null, dueComplete: !!j.dueComplete,
          checklist: checklist, comments: comments
        };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    })();
  }

  async function cardWholeFor(cardId) {
    if (!cardId) return { ok: false, error: 'no card' };
    return inTrelloTab(fetchCardWhole, [cardId], true);   // opening a card is a deliberate click
  }

  async function reactToMention(item, reaction) {
    const r = typeof reaction === 'string'
      ? REACTIONS.filter(function (x) { return x.emoji === reaction || x.shortName === reaction; })[0]
      : reaction;
    if (!r) return { ok: false, error: 'unknown reaction' };
    if (!item || !item.cardId) return { ok: false, error: 'this mention has no card to react on' };

    const tab = await ensureTrelloTab(true);
    if (!tab) return { ok: false, error: 'could not open a Trello tab — check you are logged into Trello in this browser' };

    const run = async function (func, args) {
      const got = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN', func: func, args: args
      });
      return (got && got[0] && got[0].result) || { ok: false, error: 'no result' };
    };

    try {
      let actionId = item.actionId || '';
      if (!actionId) {
        const found = await run(findCommentAction, [item.cardId, item.text || '', item.actorUser || '']);
        if (!found.ok) return found;
        actionId = found.id;
      }
      const posted = await run(postTrelloReaction, [actionId, r.shortName, r.unified]);
      if (posted.ok) posted.emoji = r.emoji;
      return posted;
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /* ---------- opening a card without reloading Trello ----------
     Setting location.href makes the whole board load again, which is slow and
     loses your place. Trello is a single-page app, so the same thing it does when
     you click a card works here: click the card's own link if it is on screen,
     otherwise push the URL through its router. Runs in the page, so no closure. */

  function openCardInPlace(shortLink) {
    try {
      const onThisCard = location.pathname.indexOf('/c/' + shortLink) !== -1;
      const back = document.querySelector('[data-testid="card-back-name"], .js-card-detail-window');
      if (onThisCard && back) return { ok: true, how: 'already open' };

      /* The card is on the board in front of us — click it, exactly as you would.
         This is the only route that reliably avoids a reload. A plain .click()
         is not always enough for a React board, so send the full sequence a real
         mouse would. */
      const link = document.querySelector('a[href*="/c/' + shortLink + '"]') ||
        document.querySelector('[data-testid="card-name-link"][href*="' + shortLink + '"]') ||
        document.querySelector('[href*="' + shortLink + '"]');
      if (link) {
        try {
          ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (type) {
            const Ev = /pointer/.test(type) && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
            link.dispatchEvent(new Ev(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
          });
        } catch (e) {
          link.click();
        }
        return { ok: true, how: 'clicked the card', clicked: true };
      }

      /* Not on screen — it lives on another board or is scrolled out of the
         virtual list. Say so and let the caller load it properly. Trying to fake
         a route here is what made the button silently do nothing. */
      return { ok: true, how: 'not on this board', needsNav: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /* Strictly: is THIS card open? The old version matched any element with
     "card-detail" in a class name, which is true on a plain board — so it always
     reported success and the fallback never ran. */
  function cardIsOpen(shortLink) {
    try {
      if (shortLink && location.pathname.indexOf('/c/' + shortLink) === -1) return false;
      return !!document.querySelector('[data-testid="card-back-name"], .js-card-detail-window');
    } catch (e) {
      return false;
    }
  }

  /* Open the card. That is the whole job.

     This went through three clever versions — click the card's link, push the URL
     through Trello's router, verify it worked, fall back — and each layer was one
     more thing that could quietly fail. So: navigate to the card URL. Trello
     opens the card over the board, which is what you wanted, and a plain
     navigation has no failure mode I cannot see. If there is no Trello tab, use a
     new one. Nothing is injected, nothing is verified, nothing can be swallowed. */
  async function openCardSmart(item, opts) {
    const o = opts || {};
    const shortLink = item && (item.shortLink || (String(item.href || '').match(/\/c\/([A-Za-z0-9]+)/) || [])[1]);
    const href = (item && item.href) || (shortLink ? 'https://trello.com/c/' + shortLink : '');
    if (!href) return { ok: false, error: 'this mention has no card link' };

    let tab = null;
    try {
      const tabs = await chrome.tabs.query({ url: ['*://trello.com/*', '*://*.trello.com/*'] });
      tab = (tabs || []).filter(function (t) { return t.id; })[0] || null;
    } catch (e) {}

    if (tab) {
      try { await chrome.tabs.update(tab.id, { active: true }); } catch (e) {}
      try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (e) {}

      /* First, the nice version: if the card is on the board you are looking at,
         click it, exactly as you would. That opens it with no reload.
         This is only ever an attempt — if it does not visibly work within a beat,
         we load the card below. It can make things better, never worse. */
      if (shortLink && !o.noInPlace) {
        let opened = false;
        try {
          const got = await chrome.scripting.executeScript({
            target: { tabId: tab.id }, world: 'MAIN', func: openCardInPlace, args: [shortLink]
          });
          const r = got && got[0] && got[0].result;
          if (r && r.ok && r.how === 'already open') opened = true;
          else if (r && r.ok && r.clicked) {
            await new Promise(function (rs) { setTimeout(rs, o.settleMs == null ? 350 : o.settleMs); });
            const chk = await chrome.scripting.executeScript({
              target: { tabId: tab.id }, world: 'MAIN', func: cardIsOpen, args: [shortLink]
            });
            opened = !!(chk && chk[0] && chk[0].result);
          }
        } catch (e) { opened = false; }
        if (opened) return { ok: true, how: 'opened it on the board — no reload', tabId: tab.id };
      }

      /* the guaranteed way */
      try {
        await chrome.tabs.update(tab.id, { url: href, active: true });
        return { ok: true, how: 'opened in your Trello tab', tabId: tab.id };
      } catch (e) {
        // fall through and use a new tab
      }
    }

    try {
      const made = await chrome.tabs.create({ url: href, active: true });
      return { ok: true, how: tab ? 'opened in a new tab' : 'opened a new Trello tab', tabId: made && made.id };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }


  function reactErrorMessage(res) {
    if (!res) return 'Nothing came back from Trello.';
    if (res.error) return res.error;
    if (res.status === 401 || res.status === 403) return 'Trello would not accept it — reload your Trello tab and try again.';
    if (res.status === 404) return 'That comment is no longer on the card.';
    return 'Trello said no (' + (res.status || '?') + ').';
  }

  const TRELLO_SNAPKEY = 'r_tagged_me|trello:notifications';

  /* Kept in sync storage so it is one less thing to set up again, and read
     wherever the queue is built. */
  async function getMemory() {
    try {
      const got = await chrome.storage.sync.get({ memory: null });
      const m = Object.assign({ trustTrelloRead: true, zone: BIZ_ZONE_DEFAULT }, got.memory || {});
      setZone(m.zone);            // every date decision below now uses the firm's day
      return m;
    } catch (e) {
      return { trustTrelloRead: true, zone: BIZ_ZONE };
    }
  }

  async function setMemory(patch) {
    const cur = await getMemory();
    const next = Object.assign(cur, patch || {});
    try { await chrome.storage.sync.set({ memory: next }); } catch (e) { /* not fatal */ }
    return next;
  }

  /* turn raw notifications into the same shape the popup renders */
  function trelloResults(raw, snapshots, opts) {
    const names = (opts && opts.names) || ['@rafay10', '@rafay', 'Rafay'];
    /* Whether a mention Trello already considers read counts as dealt with.
       On by default, because it is the only record that survives this extension
       being reinstalled. Off, and the local note is the only word — which is what
       made him press Done on the same cards after every install. */
    const trustRead = !(opts && opts.trustTrelloRead === false);
    const sinceMs = (opts && opts.sinceMs) || 0;
    const untilMs = (opts && opts.untilMs) || 0;
    const snap = (snapshots && snapshots[TRELLO_SNAPKEY]) || { hashes: {}, lastChecked: 0 };
    const group = {
      rule: { id: 'r_tagged_me', name: 'Who tagged me in a comment?' },
      snapKey: TRELLO_SNAPKEY,
      source: 'trello-api',
      items: [], people: [], newCount: 0, total: 0,
      hiddenOld: 0, undatedPage: false, matchedBeforeDateFilter: 0,
      /* Mentions kept out of the queue ONLY because Trello says they were read.
         Counted so the panel can point at them: something read in Trello but
         never dealt with here — "K-1s came in when you get a chance" — must not
         disappear without a word. */
      readElsewhere: 0,
      neverChecked: !snap.lastChecked, lastChecked: snap.lastChecked || 0,
      note: ''
    };

    if (!raw || !raw.ok) {
      group.note = raw && raw.status === 401
        ? 'Trello says you\'re not logged in on this tab — sign in to Trello and press Rescan.'
        : 'Couldn\'t read your Trello notifications' + (raw && (raw.status || raw.error) ? ' (' + (raw.status || raw.error) + ')' : '') + '. Falling back to reading the page.';
      group.failed = true;
      return group;
    }

    const mentionsMe = (t) => names.some((n) => {
      const nn = normalize(n).toLowerCase();
      return nn && (t || '').toLowerCase().indexOf(nn) !== -1;
    });

    const all = [];
    (raw.items || []).forEach((n) => {
      const tagged = n.type === 'mentionedOnCard';
      const commentAtMe = n.type === 'commentCard' && mentionsMe(n.text);
      if (!tagged && !commentAtMe) return; // ignore card-membership and other noise
      const when = Date.parse(n.date) || 0;
      const body = normalize(n.text) || '(no comment text)';
      all.push({
        text: body.length > MAX_SNIPPET ? body.slice(0, MAX_SNIPPET) + '…' : body,
        actor: n.actor,
        actorUser: n.actorUser || '',
        /* Trello's notification payload doesn't always carry the card's internal
           id even when it carries everything else about the card (name, list,
           board) — shortLink is the reliable one (it's what "Open card" already
           depends on), and Trello's card-scoped API endpoints accept it in place
           of the internal id, so it's a safe fallback rather than a workaround. */
        cardId: n.cardId || n.shortLink || '',
        actionId: n.actionId || '',
        boardId: n.boardId || '',
        cardName: n.cardName || '',
        listName: n.listName || '',
        boardName: n.boardName || '',
        headline: n.actor + ' tagged you in a comment on “' + (n.cardName || 'a card') + '”',
        href: n.shortLink ? 'https://trello.com/c/' + n.shortLink : '',
        shortLink: n.shortLink || '',
        source: 'trello',
        /* carried through to the panel: undefined means Trello was not asked,
           null means the card genuinely has no deadline. Losing the distinction
           here made every single card cost a lookup. */
        due: n.due,
        dueComplete: n.dueComplete,
        hash: 'tn:' + n.id,
        reasons: [n.boardName || 'Trello'].concat(n.unread ? ['unread in Trello'] : []),
        unread: !!n.unread,
        when: when,
        /* Not dealt with here, and — if he wants Trello's word to count — not
           already read there either. Trello's flag is the durable half: it is what
           survives this extension being reinstalled. */
        isNew: (trustRead ? !!n.unread : true) &&
          !Object.prototype.hasOwnProperty.call(snap.hashes, 'tn:' + n.id),
        readInTrello: !n.unread,
        firstSeen: snap.hashes['tn:' + n.id] || null
      });
    });

    group.matchedBeforeDateFilter = all.length;
    let kept = all;
    if (sinceMs || untilMs) {
      kept = all.filter((i) => !i.when || ((!sinceMs || i.when >= sinceMs) && (!untilMs || i.when < untilMs)));
      group.hiddenOld = all.length - kept.length;
    }
    kept.sort((a, b) => ((b.isNew ? 1 : 0) - (a.isNew ? 1 : 0)) || ((b.when || 0) - (a.when || 0)));

    const who = new Map();
    kept.forEach((i) => {
      const a = i.headline.split(' tagged you')[0];
      who.set(a, (who.get(a) || 0) + 1);
    });
    group.people = Array.from(who.entries()).sort((x, y) => y[1] - x[1])
      .map((e) => e[0] + (e[1] > 1 ? ' ×' + e[1] : ''));
    group.items = kept;
    group.total = kept.length;
    group.newCount = kept.filter((i) => i.isNew).length;
    /* Read in Trello, never dealt with here: counted so the panel can point at
       them. Computed from what is actually in view, not from everything ever. */
    group.readElsewhere = kept.filter(function (i) {
      return i.readInTrello && !i.isNew &&
        !Object.prototype.hasOwnProperty.call(snap.hashes, i.hash);
    }).length;
    return group;
  }

  function isTrello(url) {
    return /^https?:\/\/([a-z0-9-]+\.)?trello\.com\//i.test(url || '');
  }

  /* ---------- Canopy ----------
     Read whatever Canopy page you are on: which client, where in their folders,
     what files are there, and what is sitting unfiled in the File Inbox.

     Everything here works off STRUCTURE, not class names. The file list is found
     by looking for a table whose headers say "Name" and "Date added" — that
     survives a redesign, which is more than the last attempt managed. */

  function isCanopy(url) {
    return /^https?:\/\/[^/]*(getcanopy\.com|canopytax\.com|canopy\.us)\//i.test(url || '');
  }

  function readCanopyPage() {
    const out = {
      ok: true, url: location.href, title: document.title,
      clientId: '', section: '', client: '', clientType: '',
      crumbs: [], files: [], inbox: [], folders: [], headings: []
    };
    const clean = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
    /* Each part is attempted on its own. One awkward selector must not throw the
       whole read away — partial information beats "could not read the page". */
    out.trouble = [];
    const safe = (what, fn) => {
      try { fn(); } catch (e) { out.trouble.push(what + ': ' + ((e && e.message) || e)); }
    };

    safe('all', function () {
      const idm = location.href.match(/\/(?:client|contact)s?\/(\d{3,})/i);
      out.clientId = idm ? idm[1] : '';
      const sec = location.href.match(/\/(?:client|contact)s?\/\d+\/([a-z\-]+)/i);
      out.section = sec ? sec[1].toLowerCase() : '';

      /* ---- the file table: found by its own column headings ---- */
      const wanted = ['name', 'date added', 'added by', 'last modified', 'last modified by', 'visible'];
      const tables = document.querySelectorAll('table, [role="table"], [role="grid"]');
      for (let t = 0; t < tables.length; t++) {
        const table = tables[t];
        const heads = [];
        table.querySelectorAll('th, [role="columnheader"]').forEach(function (h) {
          heads.push(clean(h.textContent).toLowerCase());
        });
        if (heads.indexOf('name') === -1) continue;
        if (!heads.some(function (h) { return h === 'date added' || h === 'added by'; })) continue;

        const col = {};
        wanted.forEach(function (w) { col[w] = heads.indexOf(w); });

        const rows = table.querySelectorAll('tbody tr, [role="row"]');
        rows.forEach(function (r) {
          if (r.querySelector('th, [role="columnheader"]')) return;      // the header row
          const cells = [];
          r.querySelectorAll('td, [role="gridcell"], [role="cell"]').forEach(function (c) {
            cells.push(clean(c.textContent));
          });
          if (!cells.length) return;
          const pick = function (key, fallbackIdx) {
            const i = col[key];
            const v = i > -1 && cells[i] != null ? cells[i] : (cells[fallbackIdx] || '');
            return v;
          };
          const name = pick('name', 0);
          if (!name || name.length > 200) return;
          out.files.push({
            name: name,
            added: pick('date added', 1),
            addedBy: pick('added by', 2),
            modified: pick('last modified', 3),
            modifiedBy: pick('last modified by', 4),
            isFile: /\.[a-z0-9]{2,5}$/i.test(name)
          });
        });
        if (out.files.length) break;
      }

      /* ---- where am I: the breadcrumb, as leaf texts in order ---- */
      const crumbBox = document.querySelector(
        '[class*="breadcrumb" i], nav[aria-label*="readcrumb" i], ol[class*="crumb" i]'
      );
      if (crumbBox) {
        crumbBox.querySelectorAll('a, span, li, button, div').forEach(function (c) {
          if (c.querySelector('a, span, li, button, div')) return;
          const t = clean(c.textContent);
          if (t && t.length < 70 && t !== '>' && out.crumbs.indexOf(t) === -1) out.crumbs.push(t);
        });
      }

      /* ---- the File Inbox: unfiled things waiting to be put somewhere ---- */
      let inboxBox = null;
      const all = document.querySelectorAll('h1, h2, h3, h4, div, span, p');
      for (let i = 0; i < all.length; i++) {
        const t = clean(all[i].textContent);
        if (/^file inbox\b/i.test(t) && t.length < 80) {
          inboxBox = all[i].parentElement;
          while (inboxBox && inboxBox.querySelectorAll('*').length < 6 && inboxBox.parentElement) {
            inboxBox = inboxBox.parentElement;
          }
          break;
        }
      }
      if (inboxBox) {
        /* Leaf elements only. Reading containers too gave every file twice, once
           with the date glued onto the end of its name. */
        const seen = {};
        inboxBox.querySelectorAll('*').forEach(function (el) {
          if (out.inbox.length > 40) return;
          if (el.children && el.children.length) return;
          const name = clean(el.textContent);
          if (name.length < 4 || name.length > 140) return;
          if (!/\.[a-z0-9]{2,5}$/i.test(name)) return;
          if (seen[name.toLowerCase()]) return;
          seen[name.toLowerCase()] = 1;

          // the date and the sender live in sibling cells of the same row
          const rowText = clean(el.parentElement ? el.parentElement.textContent : name);
          const dm = rowText.match(/\d{1,2}\/\d{1,2}\/\d{2,4}/);
          const who = clean(rowText.split(name).join(' ').split(dm ? dm[0] : ' ').join(' '));
          out.inbox.push({ name: name, date: dm ? dm[0] : '', who: who.slice(0, 60) });
        });
      }

      /* ---- the folder tree, with its counts ---- */
      const treeRows = document.querySelectorAll('[role="treeitem"], [class*="tree" i] li, [class*="folder" i]');
      const fseen = {};
      treeRows.forEach(function (el) {
        if (out.folders.length > 60) return;
        if (el.querySelector('[role="treeitem"]')) return;
        const t = clean(el.textContent);
        const m = t.match(/^(.{2,60}?)\s*(\d{1,4})?$/);
        if (!m) return;
        const nm = clean(m[1]);
        if (!nm || nm.length < 2 || fseen[nm.toLowerCase()]) return;
        fseen[nm.toLowerCase()] = 1;
        out.folders.push({ name: nm, count: m[2] ? parseInt(m[2], 10) : null });
      });

      /* ---- who this is: the breadcrumb's first crumb is the client ---- */
      if (out.crumbs.length) out.client = out.crumbs[0];
      document.querySelectorAll('h1, h2, [class*="page-title" i], [class*="client-name" i]').forEach(function (el) {
        const t = clean(el.textContent);
        if (t && t.length < 80) out.headings.push(t);
      });
      if (!out.client && out.headings.length) out.client = out.headings[0];
      /* Canopy shows "Business" or "Individual" just under the name */
      for (let i = 0; i < out.headings.length; i++) {
        if (/^(business|individual)$/i.test(out.headings[i])) { out.clientType = out.headings[i]; break; }
      }
      if (!out.clientType) {
        /* Canopy prints it as its own small line under the client's name */
        const bits = document.querySelectorAll('div, span, p, small, h3, h4');
        for (let i = 0; i < bits.length && i < 400; i++) {
          if (bits[i].children && bits[i].children.length) continue;
          const t = clean(bits[i].textContent);
          if (/^(business|individual)$/i.test(t)) { out.clientType = t; break; }
        }
      }
    });
    return out;
  }

  /* Ask the page for itself, so a page that reads oddly can be looked at
     properly instead of guessed at from a screenshot. Read-only, and it goes
     nowhere until he chooses to send it. */
  async function canopyDump(preferTabId) {
    const problems = [];
    const ids = [];
    if (preferTabId) ids.push(preferTabId);
    try {
      const tabs = await chrome.tabs.query({
        url: ['*://*.getcanopy.com/*', '*://*.canopytax.com/*', '*://canopy.us/*']
      });
      (tabs || []).forEach(function (t) { if (t.id && ids.indexOf(t.id) === -1) ids.push(t.id); });
    } catch (e) { problems.push('could not list tabs: ' + ((e && e.message) || e)); }

    for (const id of ids) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await new Promise(function (resolve) {
          let settled = false;
          const done = function (v) { if (!settled) { settled = true; resolve(v); } };
          setTimeout(function () { done(null); }, 8000);
          try {
            chrome.tabs.sendMessage(id, { type: 'canopyDump' }, function (resp) {
              const err = chrome.runtime && chrome.runtime.lastError;
              done(err ? null : resp);
            });
          } catch (e) { done(null); }
        });
        if (r && r.ok && r.html) return r;
        if (attempt === 0) {
          /* the reader is not in this tab yet: put it there and ask again */
          try {
            await chrome.scripting.executeScript({
              target: { tabId: id, allFrames: false }, files: ['canopy-watch.js']
            });
          } catch (e) {
            problems.push('tab ' + id + ': ' + ((e && e.message) || e));
            break;
          }
        } else {
          problems.push('tab ' + id + ': the page did not hand itself over');
        }
      }
    }
    return { ok: false, problems: problems.length ? problems : ['no Canopy tab is open'] };
  }

  /* Hand over ANY page as the extension sees it — Gmail, Canopy, a Trello board.
     Injected as a file on demand, which is the route that proved reliable; then
     asked for the page. Read-only, and it goes nowhere until he chooses to send
     it, which is a decision worth him making deliberately: a Gmail dump contains
     client correspondence. */
  async function dumpPage(tabId) {
    const problems = [];
    let id = tabId;
    if (!id) {
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        id = (tabs && tabs[0] && tabs[0].id) || 0;
      } catch (e) { problems.push('could not find the active tab: ' + ((e && e.message) || e)); }
    }
    if (!id) return { ok: false, problems: problems.length ? problems : ['no tab to read'] };

    const ask = () => new Promise(function (resolve) {
      let settled = false;
      const done = function (v) { if (!settled) { settled = true; resolve(v); } };
      setTimeout(function () { done(null); }, 10000);
      try {
        chrome.tabs.sendMessage(id, { type: 'pageDump' }, function (resp) {
          const err = chrome.runtime && chrome.runtime.lastError;
          done(err ? null : resp);
        });
      } catch (e) { done(null); }
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await ask();
      if (r && r.ok && r.html) return r;
      if (r && r.error) problems.push('the page said: ' + r.error);
      if (attempt === 0) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: id, allFrames: false }, files: ['page-dump.js']
          });
        } catch (e) {
          problems.push('could not load the reader here: ' + ((e && e.message) || e) +
            ' — Chrome blocks extensions on its own pages and on the Chrome Web Store.');
          break;
        }
      } else {
        problems.push('the page did not answer');
      }
    }
    return { ok: false, problems: problems };
  }

  /* Read the Canopy tab you are on (or any Canopy tab that is open).

     Note the world: reading the DOM does NOT need the page's own context, and
     'MAIN' is subject to the page's Content Security Policy — which is the most
     likely reason an injection into Canopy silently produces nothing. The default
     isolated world can read the same DOM and no CSP can stop it. MAIN is kept
     only as a fallback. Whatever goes wrong is reported, not swallowed. */
  async function canopyRead(preferTabId) {
    const problems = [];

    /* When a route hands back something we reject, show what it actually was.
       "frame answered with object" was one guess short of useful. */
    const dump = function (v) {
      try {
        if (v && typeof v === 'object') {
          const k = Object.keys(v);
          return 'ok=' + JSON.stringify(v.ok) + ' keys{' + k.slice(0, 14).join(',') +
            (k.length > 14 ? ',\u2026' : '') + '} ' + JSON.stringify(v).slice(0, 200);
        }
        return JSON.stringify(v);
      } catch (e) { return '(could not be inspected: ' + ((e && e.message) || e) + ')'; }
    };

    /* Load the reader into a tab that does not have it yet.
       This injects the FILE, not a serialised function — a different mechanism
       from the one that kept coming back empty — and it means an already-open
       Canopy tab works without being reloaded by hand. */
    const boot = async function (id) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: id, allFrames: false }, files: ['canopy-watch.js']
        });
        return true;
      } catch (e) {
        problems.push('tab ' + id + ' (loading the reader): ' + ((e && e.message) || e));
        return false;
      }
    };

    /* First choice: the content script Chrome injects itself on Canopy. It holds
       the live document and simply answers — nothing to inject, nothing to block.
       executeScript came back empty in both worlds, so this is the primary route
       and injection is now the fallback, not the other way round. */
    const ask = async (id, label) => {
      try {
        const r = await new Promise(function (resolve) {
          let settled = false;
          const done = function (v) { if (!settled) { settled = true; resolve(v); } };
          setTimeout(function () { done({ __timeout: true }); }, 2500);
          try {
            chrome.tabs.sendMessage(id, { type: 'canopyRead' }, function (resp) {
              const err = chrome.runtime && chrome.runtime.lastError;
              done(err ? { __error: err.message } : resp);
            });
          } catch (e) {
            done({ __error: String((e && e.message) || e) });
          }
        });
        if (r && r.ok) return r;
        problems.push('tab ' + id + ' (content script' + (label || '') + '): ' +
          (r && r.__timeout ? 'no answer in 2.5s'
            : r && r.__error ? r.__error
              : (r && r.error) ? r.error
                : 'answered but was rejected \u2014 ' + dump(r)));
      } catch (e) {
        problems.push('tab ' + id + ' (content script' + (label || '') + '): ' + ((e && e.message) || e));
      }
      return null;
    };

    const run = async (id, world) => {
      try {
        const opts = { target: { tabId: id }, func: readCanopyPage };
        if (world) opts.world = world;
        const got = await chrome.scripting.executeScript(opts);
        const r = got && got[0] && got[0].result;
        if (r && r.ok) { r.via = 'injected (' + (world || 'isolated') + ')'; return r; }
        /* say precisely what came back — "returned nothing" told us nothing */
        problems.push('tab ' + id + ' (' + (world || 'isolated') + '): ' +
          ((r && r.error) ? r.error
            : !got ? 'executeScript returned no array'
              : got.length === 0 ? 'no frames answered'
                : 'frame answered with ' + (typeof r) + ' ' + dump(r) +
                  (got[0] && got[0].error ? ' / frame error: ' + got[0].error : '')));
      } catch (e) {
        problems.push('tab ' + id + ' (' + (world || 'isolated') + '): ' + ((e && e.message) || e));
      }
      return null;
    };

    const ids = [];
    if (preferTabId) ids.push(preferTabId);
    try {
      const tabs = await chrome.tabs.query({
        url: ['*://*.getcanopy.com/*', '*://*.canopytax.com/*', '*://canopy.us/*']
      });
      (tabs || []).forEach(function (t) { if (t.id && ids.indexOf(t.id) === -1) ids.push(t.id); });
    } catch (e) {
      problems.push('could not list tabs: ' + ((e && e.message) || e));
    }

    for (const id of ids) {
      const said = await ask(id);               // the content script, first choice
      if (said) return said;
      /* not there yet \u2014 put it there ourselves rather than asking you to reload */
      if (await boot(id)) {
        const said2 = await ask(id, ', after loading it');
        if (said2) return said2;
      }
      const iso = await run(id, null);          // then injection, isolated world
      if (iso) return iso;
      const main = await run(id, 'MAIN');       // then the page's own world
      if (main) return main;
    }

    return {
      ok: false,
      error: ids.length
        ? 'Could not read the Canopy page.'
        : 'No Canopy tab is open.',
      problems: problems
    };
  }

  /* ---------- Gmail ----------
     Same idea as Canopy: gmail-watch.js sits on mail.google.com as a declared
     content script and answers when asked, rather than being injected fresh
     each time. Read-only — it never clicks, sends, or changes anything. */

  function isGmail(url) {
    return /^https?:\/\/mail\.google\.com\//i.test(url || '');
  }

  async function gmailRead(preferTabId) {
    const problems = [];

    const boot = async function (id) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: id, allFrames: false }, files: ['gmail-watch.js']
        });
        return true;
      } catch (e) {
        problems.push('tab ' + id + ' (loading the reader): ' + ((e && e.message) || e));
        return false;
      }
    };

    const ask = async (id, label) => {
      try {
        const r = await new Promise(function (resolve) {
          let settled = false;
          const done = function (v) { if (!settled) { settled = true; resolve(v); } };
          setTimeout(function () { done({ __timeout: true }); }, 2500);
          try {
            chrome.tabs.sendMessage(id, { type: 'gmailRead' }, function (resp) {
              const err = chrome.runtime && chrome.runtime.lastError;
              done(err ? { __error: err.message } : resp);
            });
          } catch (e) {
            done({ __error: String((e && e.message) || e) });
          }
        });
        if (r && r.ok) return r;
        problems.push('tab ' + id + ' (content script' + (label || '') + '): ' +
          (r && r.__timeout ? 'no answer in 2.5s'
            : r && r.__error ? r.__error
              : (r && r.error) ? r.error
                : 'answered but was rejected'));
      } catch (e) {
        problems.push('tab ' + id + ' (content script' + (label || '') + '): ' + ((e && e.message) || e));
      }
      return null;
    };

    const ids = [];
    if (preferTabId) ids.push(preferTabId);
    try {
      const tabs = await chrome.tabs.query({ url: ['*://mail.google.com/*'] });
      (tabs || []).forEach(function (t) { if (t.id && ids.indexOf(t.id) === -1) ids.push(t.id); });
    } catch (e) {
      problems.push('could not list tabs: ' + ((e && e.message) || e));
    }

    for (const id of ids) {
      const said = await ask(id);
      if (said) return said;
      if (await boot(id)) {
        const said2 = await ask(id, ', after loading it');
        if (said2) return said2;
      }
    }

    return {
      ok: false,
      error: ids.length ? 'Could not read the Gmail page.' : 'No Gmail tab is open.',
      problems: problems
    };
  }

  function buildGmailContext(gmail) {
    const out = [];
    out.push('TODAY: ' + new Date().toString());
    out.push('GMAIL PAGE: ' + (gmail.url || ''));
    if (gmail.subject) out.push('SUBJECT: ' + gmail.subject);
    if ((gmail.participants || []).length) out.push('PARTICIPANTS: ' + gmail.participants.join(', '));
    if ((gmail.messages || []).length) {
      out.push('');
      out.push('MESSAGES IN THIS THREAD (as shown on screen):');
      gmail.messages.forEach(function (m, i) {
        out.push('--- message ' + (i + 1) + (m.from ? ' from ' + m.from : '') + (m.when ? ' (' + m.when + ')' : '') + ' ---');
        out.push(m.body || '(no body captured)');
      });
    }
    if ((gmail.inboxRows || []).length) {
      out.push('');
      out.push('VISIBLE ROWS (an inbox / search / label list, not a single open thread):');
      gmail.inboxRows.slice(0, 40).forEach(function (r) {
        out.push('- ' + (r.from || '?') + ' — ' + (r.subject || '(no subject)') +
          (r.snippet ? ': ' + r.snippet : '') + (r.date ? ' [' + r.date + ']' : ''));
      });
    }
    if (gmail.pageText) {
      out.push('');
      out.push('RAW VISIBLE TEXT ON THE PAGE (fallback, may include noise or repeat the above):');
      out.push(gmail.pageText);
    }
    let ctx = out.join('\n');
    if (ctx.length > 12000) ctx = ctx.slice(0, 12000) + '\n…(truncated)';
    return ctx;
  }

  const GMAIL_QA_SYSTEM = [
    'You answer a tax professional\'s question about a client using only what is visible on the Gmail tab he has open right now — an email thread or an inbox/search list.',
    'You are given SUBJECT, PARTICIPANTS, MESSAGES (or visible rows from a list), and sometimes raw visible page text as a fallback.',
    'Rules:',
    '1. Answer ONLY from the context given. Never invent a name, date, amount, or detail not present.',
    '2. If this page is not about the client asked about, or the answer is not there, say so plainly — e.g. "This thread is not about that client" or "That is not mentioned here."',
    '3. Be brief and concrete. Quote the relevant line rather than paraphrasing it away.',
    '4. Plain prose, no markdown headers, no restating the question.'
  ].join('\n');

  /* Gemini, not Claude — reuses the same key as "Sort mentions" and the daily
     update, rather than asking for a third. */
  async function answerAboutGmail(question, gmail) {
    const cfg = await getTriage();
    if (!cfg.apiKey) {
      const e = new Error('No Gemini key yet. Open Settings → Sort mentions and paste your Google AI Studio key.');
      e.needsKey = true;
      throw e;
    }
    const context = buildGmailContext(gmail);
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(cfg.model || 'gemini-flash-latest') + ':generateContent';

    let res;
    try {
      res = await fetchGeminiRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: GMAIL_QA_SYSTEM }] },
          contents: [{ role: 'user', parts: [{ text: 'CONTEXT:\n' + context + '\n\nQUESTION: ' + question }] }],
          /* Flash's default "thinking" tokens count against maxOutputTokens —
             with a small cap, the model could spend the whole budget
             reasoning and get cut off before writing any answer at all.
             thinkingBudget: 0 turns that off; this is direct extraction, not
             a task that benefits from chain-of-thought. */
          generationConfig: { temperature: 0.2, maxOutputTokens: 700, thinkingConfig: { thinkingBudget: 0 } }
        })
      });
    } catch (e) {
      throw new Error('Could not reach Gemini (offline?): ' + ((e && e.message) || e));
    }
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = (body && body.error && body.error.message) || '';
      } catch (e) { /* the status is enough */ }
      throw new Error(triageError(res.status, detail));
    }
    const body = await res.json();
    const candidate = (body.candidates || [])[0] || {};
    const parts = (candidate.content || {}).parts;
    const text = (parts || []).map(function (p) { return p.text || ''; }).join('\n').trim();
    if (candidate.finishReason === 'MAX_TOKENS') {
      throw new Error('Gemini\'s answer got cut off before it finished — try asking again.');
    }
    return { text: text || '(empty answer)' };
  }

  /* ---------- ask-a-question, answered locally ----------
     No AI, no key, no network: your question is turned into search terms and run
     against your Trello notifications and the current page. Answers are always
     real quotes from your data, so nothing can be invented. */

  const STOP = ('the a an is are was were do does did am be been being i me my mine we us our you your yours he she it they them their ' +
    'to of in on for about with without any anything something someone anyone there that this these those and or but not no if so as at ' +
    'by from into over under again just only also very much many more most some all every each other than then now ever still yet ' +
    'have has had can could would should will shall may might must need needs want wants know knows tell show give list find get see ' +
    'what which who whom whose when where why how please pls thanks thank ok okay hey hi anything else').split(' ');
  // domain filler: asking "how many people tagged me" shouldn't search for "people"
  const GENERIC = ('people person someone somebody item items thing things stuff message messages msg ' +
    'notification notifications mention mentions mentioned tag tags tagged tagging comment comments commented ' +
    'card cards board boards list lists unread read new update updates activity feed anyone').split(' ');
  const STOPSET = new Set(STOP.concat(GENERIC));

  const TIME_WORDS = [
    { re: /\btoday\b/i, mode: 'today' },
    { re: /\byesterday\b/i, mode: '48h' },
    { re: /\blast\s+24\s*h(ours?)?\b|\bpast\s+day\b/i, mode: '24h' },
    { re: /\bthis\s+week\b|\blast\s+7\s*days?\b|\bpast\s+week\b|\bthis\s+wk\b/i, mode: '7d' },
    { re: /\blast\s+month\b|\bpast\s+month\b|\bever\b|\ball\s+time\b|\bany\s*time\b/i, mode: 'any' }
  ];

  function parseQuestion(q, names) {
    const raw = String(q || '');
    const low = raw.toLowerCase();
    const phrases = [];
    raw.replace(/"([^"]{2,60})"/g, (m, p) => { phrases.push(p.toLowerCase()); return ' '; });

    const intent = {
      who: /\bwho\b|\bwhom\b/i.test(low),
      when: /\bwhen\b|\bhow long\b/i.test(low),
      count: /\bhow many\b/i.test(low),
      unreadOnly: /\bunread\b|\bnot read\b/i.test(low),
      newOnly: /\bnew\b|\bnot handled\b|\boutstanding\b|\bstill\b/i.test(low),
      aboutMe: /\bme\b|\bmy\b|\bmine\b|\bi\b|rafay/i.test(low),
      docs: /\bdoc(ument)?s?\b|\bfile(s)?\b|\bupload(ed|s)?\b|\battach(ed|ment)?s?\b|\bpdf\b/i.test(low)
    };

    let timeMode = null;
    let stripped = low;
    TIME_WORDS.forEach((t) => {
      if (t.re.test(stripped)) {
        if (!timeMode) timeMode = t.mode;
        stripped = stripped.replace(t.re, ' '); // "this week" is a filter, not a search term
      }
    });

    const terms = stripped
      .replace(/"[^"]*"/g, ' ')
      .replace(/[^\p{L}\p{N}@._-]+/gu, ' ')
      .split(' ')
      .map((w) => w.trim())
      .filter((w) => w.length > 1 && !STOPSET.has(w))
      // my own name isn't a search term, it's the "about me" flag
      .filter((w) => !(names || []).some((n) => normalize(n).toLowerCase().replace(/^@/, '') === w.replace(/^@/, '')));

    return { terms: Array.from(new Set(phrases.concat(terms))), intent: intent, timeMode: timeMode, raw: raw.trim() };
  }

  function answerCorpus(state, names) {
    const out = [];
    const seen = new Set();
    const push = (o) => {
      const k = o.hash || ((o.text || '').slice(0, 120) + '|' + (o.href || ''));
      if (seen.has(k)) return;
      seen.add(k);
      const k2 = (o.text || '').slice(0, 120) + '|' + (o.href || '');
      if (seen.has(k2)) return;
      seen.add(k2);
      out.push(o);
    };
    const mentionsMe = (t) => (names || []).some((n) => {
      const nn = normalize(n).toLowerCase();
      return nn && (t || '').toLowerCase().indexOf(nn) !== -1;
    });

    const raw = state && state.trelloRaw;
    if (raw && raw.ok) {
      (raw.items || []).forEach((n) => push({
        kind: 'trello',
        tagged: n.type === 'mentionedOnCard' || (n.type === 'commentCard' && mentionsMe(n.text)),
        actor: n.actor || '',
        card: n.cardName || '',
        board: n.boardName || '',
        list: n.listName || '',
        text: normalize(n.text),
        when: Date.parse(n.date) || 0,
        href: n.shortLink ? 'https://trello.com/c/' + n.shortLink : '',
        unread: !!n.unread,
        hash: 'tn:' + n.id,
        type: n.type
      }));
    }

    (state && state.results || []).forEach((r) => {
      (r.items || []).forEach((i) => push({
        kind: 'item',
        tagged: true,
        actor: (i.headline || '').split(' tagged you')[0] || '',
        card: '',
        text: normalize((i.headline ? i.headline + ' — ' : '') + i.text),
        when: i.when || 0,
        href: i.href || '',
        unread: false,
        hash: i.hash,
        isNew: i.isNew,
        rule: r.rule.name
      }));
    });

    const page = (state && state.page) || {};
    ((page.units && page.units.length ? page.units : page.blocks) || []).slice(0, 500).forEach((u, idx) => push({
      kind: 'page', tagged: false, actor: '', card: '',
      text: normalize(u.text), when: u.when || 0, href: u.href || '', unread: false, hash: 'pg' + idx
    }));

    return out;
  }

  /* returns { summary, items, terms, note } */
  function localAnswer(question, state, opts) {
    const names = (opts && opts.names) || ME;
    const q = parseQuestion(question, names);
    const corpus = answerCorpus(state, names);
    const sinceMs = q.timeMode
      ? (q.timeMode === '48h' ? Date.now() - 2 * 864e5 : rangeFor(q.timeMode).since())
      : ((opts && opts.sinceMs) || 0);

    const scored = [];
    corpus.forEach((c) => {
      const hay = (c.text + ' ' + c.actor + ' ' + c.card + ' ' + c.list + ' ' + c.board + ' ' + (c.href || '')).toLowerCase();
      let score = 0;
      q.terms.forEach((t) => { if (hay.indexOf(t) !== -1) score += (t.indexOf(' ') !== -1 ? 3 : 1); });
      if (q.terms.length && !score) return;
      if (q.intent.aboutMe && c.kind === 'trello' && !c.tagged) return;
      if (q.intent.aboutMe && c.kind === 'page') return;
      if (q.intent.unreadOnly && !c.unread) return;
      if (q.intent.newOnly && c.isNew === false) return;
      if (q.intent.docs && !/\.(pdf|docx?|xlsx?|csv|pptx?|jpe?g|png)\b|upload|attach|paystub|organizer|return|statement|financial/i.test(c.text)) return;
      if (sinceMs && c.when && c.when < sinceMs) return;
      if (c.tagged) score += 2;
      if (c.unread) score += 1;
      if (c.kind === 'trello') score += 2;
      if (c.kind === 'page') score -= 1;
      scored.push(Object.assign({ score: score }, c));
    });

    scored.sort((a, b) => (b.score - a.score) || ((b.when || 0) - (a.when || 0)));
    const items = scored.slice(0, 25).map((c) => ({
      text: c.text.length > MAX_SNIPPET ? c.text.slice(0, MAX_SNIPPET) + '…' : c.text,
      actor: c.actor || '',
      cardName: c.card || '',
      boardName: c.board || '',
      headline: c.kind === 'trello'
        ? c.actor + (c.tagged ? ' tagged you' : ' commented') + (c.card ? ' on “' + c.card + '”' : '')
        : '',
      href: c.href, when: c.when, hash: c.hash, unread: c.unread, kind: c.kind,
      reasons: (c.board ? [c.board] : []).concat(c.unread ? ['unread in Trello'] : []),
      isNew: c.isNew !== false
    }));

    // plain-language summary, built only from what was actually found
    const actors = [];
    scored.forEach((c) => { if (c.actor && actors.indexOf(c.actor) === -1) actors.push(c.actor); });
    const termLabel = q.terms.length ? '“' + q.terms.join('”, “') + '”' : '';
    const windowLabel = q.timeMode
      ? (q.timeMode === 'today' ? 'today' : q.timeMode === '48h' ? 'in the last 2 days'
        : q.timeMode === '24h' ? 'in the last 24 hours' : q.timeMode === '7d' ? 'in the last 7 days' : 'at any time')
      : '';
    let summary;
    if (!scored.length) {
      summary = 'Nothing' + (termLabel ? ' about ' + termLabel : '') +
        (windowLabel ? ' ' + windowLabel : '') + ' in your Trello notifications or on this page.';
      if (q.intent.aboutMe) summary += ' (Only comments that tag you were considered — drop the word "me" to search everything.)';
    } else if (q.intent.who) {
      const list = actors.slice(0, 4).join(', ') + (actors.length > 4 ? ' and ' + (actors.length - 4) + ' more' : '');
      summary = (list || 'Someone') + ' — ' + scored.length + ' item' + (scored.length === 1 ? '' : 's') +
        (termLabel ? ' about ' + termLabel : '') + (windowLabel ? ' ' + windowLabel : '') +
        (items[0].when ? ', newest ' + ago(items[0].when) : '') + '.';
    } else if (q.intent.count) {
      summary = scored.length + (termLabel ? ' about ' + termLabel : '') + (windowLabel ? ' ' + windowLabel : '') + '.';
    } else if (q.intent.when && items[0].when) {
      summary = 'Most recent: ' + ago(items[0].when) + ' (' + new Date(items[0].when).toLocaleString() + ')' +
        (actors[0] ? ', from ' + actors[0] : '') + '. ' + scored.length + ' item' + (scored.length === 1 ? '' : 's') + ' total.';
    } else {
      summary = scored.length + ' match' + (scored.length === 1 ? '' : 'es') +
        (termLabel ? ' for ' + termLabel : '') + (windowLabel ? ' ' + windowLabel : '') +
        (actors.length ? ' — from ' + actors.slice(0, 3).join(', ') : '') +
        (items[0].when ? ', newest ' + ago(items[0].when) : '') + '.';
    }

    return { summary: summary, items: items, terms: q.terms, intent: q.intent, timeMode: q.timeMode, total: scored.length };
  }

  /* ---------- ask-a-question (Claude) ----------
     Everything above is local. This part, and only this part, sends text to
     Anthropic's API — and only when you press Ask. */

  const MAX_CONTEXT = 14000;
  const AI_MODELS = [
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 — best answers' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 — cheapest, fastest' },
    { id: 'claude-opus-5', label: 'Claude Opus 5 — most capable, priciest' }
  ];

  /* ================= triage =================
     Sorting mentions into "needs me", "waiting on someone else" and "just so you
     know". This is the one job worth handing to a model: deciding whether a
     sentence is an ask or a note is a judgement about language, which a model is
     good at and a keyword list is not.

     Two rules hold it in place.

     1. It LABELS AND REORDERS. It never removes anything from the queue. If the
        model gets one wrong, that costs a glance; if a mislabelled item were
        hidden, it would cost a deadline in March.
     2. With no key, or a failing key, the queue is exactly what it is today.
        Nothing about this is load-bearing.

     Only the comment text, the card name and who wrote it are sent. */

  const BUCKETS = {
    needs: { key: 'needs', label: 'Needs me', rank: 0 },
    waiting: { key: 'waiting', label: 'Waiting', rank: 1 },
    fyi: { key: 'fyi', label: 'FYI', rank: 2 }
  };

  /* A hardcoded model list went stale within months: gemini-2.5-pro stopped being
     offered to new keys and the whole feature answered "404, no longer available".
     Google will publish what a key can actually use, so ask rather than guess.
     This list is only the fallback for when that call cannot be made. */
  const GEMINI_MODELS = [
    { id: 'gemini-flash-latest', label: 'Gemini Flash (latest) — quick and cheap' },
    { id: 'gemini-pro-latest', label: 'Gemini Pro (latest) — better judgement, slower' }
  ];

  function geminiModelLabel(id, display, desc) {
    const name = display || id;
    if (/flash-lite/i.test(id)) return name + ' — cheapest, roughest';
    if (/flash/i.test(id)) return name + ' — quick and cheap';
    if (/pro/i.test(id)) return name + ' — better judgement, slower';
    return name;
  }

  /* What this key is actually allowed to use, newest-looking first. */
  async function listGeminiModels(key) {
    if (!key) return { ok: false, models: [], why: 'no key' };
    try {
      const res = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
        { headers: { 'x-goog-api-key': key } }
      );
      if (!res.ok) {
        let detail = '';
        try {
          const b = await res.json();
          detail = (b && b.error && b.error.message) || '';
        } catch (e) { /* status is enough */ }
        return { ok: false, models: [], why: triageError(res.status, detail) };
      }
      const body = await res.json();
      const usable = (body.models || []).filter(function (m) {
        const methods = m.supportedGenerationMethods || m.supported_generation_methods || [];
        return methods.indexOf('generateContent') !== -1 &&
          /gemini/i.test(m.name || '') &&
          !/embedding|aqa|imagen|veo|tts|image|native-audio|live/i.test(m.name || '');
      }).map(function (m) {
        const id = String(m.name || '').replace(/^models\//, '');
        return { id: id, label: geminiModelLabel(id, m.displayName || m.display_name) };
      });
      if (!usable.length) return { ok: false, models: [], why: 'that key lists no usable Gemini models' };

      /* prefer a flash for a job this small, and "latest" over a pinned date */
      const score = function (m) {
        let n = 0;
        if (/flash/i.test(m.id) && !/lite/i.test(m.id)) n -= 4;
        if (/latest/i.test(m.id)) n -= 2;
        if (/preview|exp/i.test(m.id)) n += 3;
        return n;
      };
      usable.sort(function (a, b) { return score(a) - score(b) || a.id.localeCompare(b.id); });
      return { ok: true, models: usable };
    } catch (e) {
      return { ok: false, models: [], why: 'Could not reach Google: ' + ((e && e.message) || e) };
    }
  }

  const TRIAGE_PROMPT = [
    'You sort Trello comments for a tax accountant. For each numbered comment,',
    'decide which one applies:',
    '',
    '  needs   - it asks him to do something, or asks him a question he must answer',
    '  waiting - someone else is doing something, or he is waiting on a client or colleague',
    '  fyi     - it just tells him something. No action for him.',
    '',
    'Reply with one line per comment, in order, exactly like:',
    '  3|needs|prepare the Q3 forecast',
    'That is: the number, a pipe, the bucket, a pipe, and at most eight words saying',
    'what the ask is. For fyi use a few words describing the update.',
    'No other text, no headings, no blank lines.'
  ].join('\n');

  const TRIAGE_DEFAULTS = { apiKey: '', model: 'gemini-flash-latest', enabled: false };

  async function getTriage() {
    /* storage may not be there at all — a bare page, a test, a worker that has
       lost its context. Defaults, not an exception. */
    try {
      const got = await chrome.storage.local.get({ triage: null });
      return Object.assign({}, TRIAGE_DEFAULTS, got.triage || {});
    } catch (e) {
      return Object.assign({}, TRIAGE_DEFAULTS);
    }
  }

  async function setTriage(patch) {
    const cur = await getTriage();
    const next = Object.assign(cur, patch || {});
    await chrome.storage.local.set({ triage: next });
    return next;
  }

  function parseTriage(text, items) {
    const out = {};
    String(text || '').split(/\r?\n/).forEach(function (line) {
      const m = line.match(/^\s*(\d+)\s*\|\s*(needs|waiting|fyi)\s*(?:\|\s*(.*))?$/i);
      if (!m) return;
      const i = parseInt(m[1], 10) - 1;
      if (i < 0 || i >= items.length) return;
      const b = BUCKETS[m[2].toLowerCase()];
      if (!b) return;
      out[items[i].hash] = {
        key: b.key, label: b.label, rank: b.rank,
        why: normalize(m[3] || '').slice(0, 90)
      };
    });
    return out;
  }

  /* Ask Gemini to sort a batch. Returns a map of hash -> bucket, and {} on any
     trouble at all — a failed triage must never cost him his queue. */
  async function triageMentions(items, opts) {
    /* Given everything up front, do not go to storage for it. */
    const given = opts || {};
    const cfg = (given.apiKey && typeof given.enabled !== 'undefined')
      ? Object.assign({}, TRIAGE_DEFAULTS, given)
      : Object.assign(await getTriage(), given);
    const list = (items || []).filter(function (i) { return i && i.hash && i.text; });
    if (!cfg.enabled || !cfg.apiKey || !list.length) {
      return { ok: false, buckets: {}, why: !cfg.enabled ? 'off' : (!cfg.apiKey ? 'no key' : 'nothing to sort') };
    }

    const numbered = list.slice(0, 25).map(function (i, n) {
      return (n + 1) + '. ' + (i.actor ? i.actor + ' on "' + (i.cardName || 'a card') + '": ' : '') +
        normalize(i.text).slice(0, 400);
    }).join('\n');

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(cfg.model || 'gemini-flash-latest') + ':generateContent';

    try {
      const res = await fetchGeminiRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: TRIAGE_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: numbered }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 1200, thinkingConfig: { thinkingBudget: 0 } }
        })
      });
      if (!res.ok) {
        let detail = '';
        try {
          const body = await res.json();
          detail = (body && body.error && body.error.message) || '';
        } catch (e) { /* the status is enough */ }
        return { ok: false, buckets: {}, why: triageError(res.status, detail) };
      }
      const body = await res.json();
      const text = (((body.candidates || [])[0] || {}).content || {}).parts;
      const said = (text || []).map(function (p) { return p.text || ''; }).join('');
      const buckets = parseTriage(said, list);
      const n = Object.keys(buckets).length;
      if (!n) return { ok: false, buckets: {}, why: 'Gemini answered in a shape I could not read' };
      return { ok: true, buckets: buckets, sorted: n, of: list.length };
    } catch (e) {
      return { ok: false, buckets: {}, why: 'Could not reach Gemini: ' + ((e && e.message) || e) };
    }
  }

  function triageError(status, detail) {
    if (status === 404 && /no longer available|not found|not supported/i.test(detail || '')) {
      return 'That model is no longer offered on this key — pick another from the list.';
    }
    if (status === 400 && /API key not valid/i.test(detail || '')) return 'That Gemini key was not accepted.';
    if (status === 401 || status === 403) return 'That Gemini key was not accepted.';
    if (status === 429) return 'Gemini is rate-limiting — it will try again later.';
    if (status >= 500) return 'Google had a problem (' + status + ').';
    return 'Gemini said no (' + status + ')' + (detail ? ': ' + detail.slice(0, 120) : '');
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* Gemini's 429 (rate-limited) and 5xx (its servers, not ours) are usually
     gone a couple seconds later — a bare fetch surfaced them as a hard
     failure on the first try, so every "AI regenerate" hiccup landed on the
     user instead of just... working on the next attempt. Retry those with
     backoff before giving up; anything else (bad key, bad model) fails fast
     since trying again cannot fix it. */
  async function fetchGeminiRetry(url, options) {
    const maxAttempts = 3;
    const baseDelayMs = 800;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res;
      try {
        res = await fetch(url, options);
      } catch (e) {
        if (attempt === maxAttempts) throw e;
        await sleep(baseDelayMs * Math.pow(2, attempt - 1));
        continue;
      }
      if (res.ok || attempt === maxAttempts) return res;
      if (res.status !== 429 && res.status < 500) return res;
      await sleep(baseDelayMs * Math.pow(2, attempt - 1));
    }
  }

  /* ================= email, from the last meeting onwards =================
     "The last meeting can be identified from the header 'Planning Call Summary'.
      Everything after that is relevant. Read AI emails are not. Calendar invites
      are not."

     That is a better anchor than the calendar: it is exact, it needs no model, and
     it sits in the same list as the emails being judged. Everything here is a
     plain rule — no AI is involved in finding the meeting or in throwing out the
     noise. A model is only worth asking the remaining question: of what is left,
     which ones are about documents. */

  /* the summary Dwight sends after a planning call */
  const MEETING_SUBJECT = /planning\s*call\s*summary/i;

  /* things that are never worth reading for this purpose */
  const EMAIL_NOISE = [
    { why: 'Read AI', re: /\bread\s*ai\b|\bread\.ai\b|meeting\s*(?:recap|report)\s*(?:from|by)\s*read/i },
    { why: 'calendar invite', re: /^(?:invitation|updated invitation|cancelled event|canceled event|accepted|declined|tentative|re:\s*invitation)\s*:/i },
    { why: 'calendar notification', re: /calendar-notification@|calendar\.google\.com/i },
    { why: 'automatic reply', re: /^(?:automatic reply|auto(?:matic)?[- ]?response|out of (?:the )?office)\b/i },
    { why: 'delivery notice', re: /^(?:undelivered|delivery status notification|mail delivery)/i },
    { why: 'no reply address', re: /\b(?:no-?reply|donotreply|notifications?)@/i }
  ];

  function emailNoise(e) {
    const subject = String((e && e.subject) || '');
    const from = String((e && e.from) || '') + ' ' + String((e && e.fromEmail) || '');
    for (let i = 0; i < EMAIL_NOISE.length; i++) {
      const n = EMAIL_NOISE[i];
      if (n.re.test(subject) || n.re.test(from)) return n.why;
    }
    return '';
  }

  /* The most recent planning call summary. Its date is when the last meeting was. */
  function lastMeetingFrom(emails) {
    let best = null;
    (emails || []).forEach(function (e) {
      if (!e || !MEETING_SUBJECT.test(String(e.subject || ''))) return;
      if (!best || (e.at || 0) > (best.at || 0)) best = e;
    });
    if (!best) return null;
    return { at: best.at || 0, subject: normalize(best.subject), from: best.from || '', email: best };
  }

  /* Everything since that meeting, minus the noise. Returns the meeting it found,
     what is worth reading, and what was set aside — with the reason, so a missing
     email is explainable rather than mysterious. */
  function emailsSinceMeeting(emails, opts) {
    const o = opts || {};
    const list = (emails || []).slice().sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
    const meeting = lastMeetingFrom(list);
    const since = meeting ? meeting.at : (o.sinceMs || 0);

    const kept = [];
    const skipped = [];
    list.forEach(function (e) {
      if (!e) return;
      if (meeting && e === meeting.email) return;              // the anchor itself
      if (since && (e.at || 0) <= since) {
        skipped.push({ email: e, why: 'before the last meeting' });
        return;
      }
      const noise = emailNoise(e);
      if (noise) { skipped.push({ email: e, why: noise }); return; }
      kept.push(e);
    });
    kept.sort(function (a, b) { return (a.at || 0) - (b.at || 0); });
    return {
      meeting: meeting,
      since: since,
      kept: kept,
      skipped: skipped,
      /* said plainly, because "3 emails" without the boundary means nothing */
      summary: meeting
        ? kept.length + ' email' + (kept.length === 1 ? '' : 's') + ' since the planning call on ' +
          shortDate(meeting.at)
        : 'No planning call summary found, so there is no meeting to count from'
    };
  }

  /* ================= the document ledger =================
     "Click on a card and it opens the whole history: what has been asked for,
      what is still pending, and what the client asked us for."

     readCardHistory already does a version of this, but only for four document
     types I hardcoded — organizer, paystubs, financials, return. Real threads
     name K-1s, 1099s, payroll returns, transcripts, engagement letters, and
     whatever next quarter invents. That list is the part I cannot keep current,
     and it is exactly what a model is good at.

     THE RULE: the model chooses which comment an entry comes from, and nothing
     else. The date and the author are then read off that comment here. So it can
     misjudge what a sentence meant — a glance to check — but it can never invent
     a date, a name, or a document that nobody mentioned. */

  const LEDGER_STATES = {
    waiting: { key: 'waiting', label: 'Still waiting', rank: 0 },
    received: { key: 'received', label: 'Received', rank: 2 },
    theyasked: { key: 'theyasked', label: 'They asked us for', rank: 1 }
  };

  const LEDGER_PROMPT = [
    'You are reading the comment thread on one tax client\'s card, for the accountant',
    'who works it. List every document or deliverable the thread mentions, once each,',
    'with what has become of it.',
    '',
    'One line per document, no other text:',
    '  status|document|comment number|at most ten words',
    '',
    'status is one of:',
    '  waiting    - we asked the client for it and it has not arrived',
    '  received   - it has arrived, or someone says it is in',
    '  theyasked  - the CLIENT asked US for it, or is waiting on us',
    '',
    'The comment number is the single comment that best shows the current state —',
    'the most recent one that settles it. Use the numbers given, nothing else.',
    'Name documents as the thread names them ("2025 K-1s", not "tax forms").',
    'If a document was asked for and later arrived, it is received, once.',
    'If the thread mentions no documents at all, reply with exactly: none'
  ].join('\n');

  function ledgerLines(text, comments) {
    const rows = [];
    const seen = {};
    String(text || '').split(/\r?\n/).forEach(function (line) {
      const m = line.match(/^\s*(waiting|received|theyasked)\s*\|\s*([^|]{1,60}?)\s*\|\s*(\d+)\s*(?:\|\s*(.*))?$/i);
      if (!m) return;
      const st = LEDGER_STATES[m[1].toLowerCase()];
      if (!st) return;
      const item = normalize(m[2]);
      if (!item) return;
      const key = item.toLowerCase();
      if (seen[key]) return;
      /* the model names a comment; the date and the author come from it, here */
      const c = comments[parseInt(m[3], 10) - 1];
      if (!c) return;
      seen[key] = 1;
      rows.push({
        item: item,
        status: st.key,
        label: st.label,
        rank: st.rank,
        at: c.at || 0,
        by: c.byName || c.by || '',
        said: normalize(m[4] || '').slice(0, 80),
        quote: normalize(c.text || '').slice(0, 200)
      });
    });
    rows.sort(function (a, b) { return a.rank - b.rank || (a.at || 0) - (b.at || 0); });
    return rows;
  }

  /* Without a key, or when Gemini will not answer: the four types we can find
     by reading the words ourselves. Less, but never nothing. */
  function ledgerFromHistory(comments, opts) {
    const h = readCardHistory(comments, opts || {});
    const rows = [];
    Object.keys(h.byDoc).forEach(function (id) {
      const r = h.byDoc[id];
      if (!r.state) return;
      rows.push({
        /* docLabels takes a LIST and returns a list — passing none gave [] and
           every row was labelled with its internal id ("payroll", "organizer"). */
        item: docLabels([id])[0] || id,
        status: r.state === 'received' ? 'received' : 'waiting',
        label: r.state === 'received' ? 'Received' : 'Still waiting',
        rank: r.state === 'received' ? 2 : 0,
        at: r.at || 0,
        by: r.by || '',
        said: r.state === 'received' ? 'in' : (r.chases > 1 ? 'chased ' + r.chases + ' times' : 'asked for'),
        quote: r.quote || ''
      });
    });
    rows.sort(function (a, b) { return a.rank - b.rank || (a.at || 0) - (b.at || 0); });
    return rows;
  }

  /* The ledger for one card. Read-only, and only when he opens it. */
  async function cardLedger(cardId, opts) {
    const o = opts || {};
    const got = o.comments ? { ok: true, comments: o.comments } : await inTrelloTab(fetchCardComments, [cardId]);
    if (!got || !got.ok) {
      return { ok: false, why: 'Could not read this card\'s comments' +
        (got && got.status ? ' (' + got.status + ')' : ''), rows: [] };
    }
    const comments = (got.comments || []).slice().sort(function (a, b) { return (a.at || 0) - (b.at || 0); });
    if (!comments.length) return { ok: true, via: 'no comments', rows: [], comments: 0 };

    const cfg = Object.assign(await getTriage(), o.triage || {});
    const plain = ledgerFromHistory(comments, o);

    if (!cfg.enabled || !cfg.apiKey) {
      return { ok: true, via: 'read from the words', rows: plain, comments: comments.length };
    }

    const numbered = comments.map(function (c, i) {
      return (i + 1) + '. [' + shortDate(c.at) + '] ' + (c.byName || c.by || 'someone') + ': ' +
        normalize(c.text).slice(0, 600);
    }).join('\n');

    try {
      const res = await fetchGeminiRetry(
        'https://generativelanguage.googleapis.com/v1beta/models/' +
        encodeURIComponent(cfg.model || 'gemini-flash-latest') + ':generateContent',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: LEDGER_PROMPT }] },
            contents: [{ role: 'user', parts: [{ text: numbered }] }],
            generationConfig: { temperature: 0, maxOutputTokens: 2000, thinkingConfig: { thinkingBudget: 0 } }
          })
        }
      );
      if (!res.ok) {
        let detail = '';
        try {
          const b = await res.json();
          detail = (b && b.error && b.error.message) || '';
        } catch (e) { /* status is enough */ }
        return { ok: true, via: 'read from the words', rows: plain, comments: comments.length,
          note: triageError(res.status, detail) };
      }
      const body = await res.json();
      const parts = (((body.candidates || [])[0] || {}).content || {}).parts || [];
      const said = parts.map(function (p) { return p.text || ''; }).join('');
      if (/^\s*none\s*$/i.test(said)) {
        return { ok: true, via: 'Gemini', rows: [], comments: comments.length };
      }
      const rows = ledgerLines(said, comments);
      if (!rows.length) {
        return { ok: true, via: 'read from the words', rows: plain, comments: comments.length,
          note: 'Gemini answered in a shape I could not read' };
      }
      return { ok: true, via: 'Gemini', rows: rows, comments: comments.length };
    } catch (e) {
      return { ok: true, via: 'read from the words', rows: plain, comments: comments.length,
        note: 'Could not reach Gemini: ' + ((e && e.message) || e) };
    }
  }

  async function getAI() {
    const got = await chrome.storage.local.get({ ai: null });
    return Object.assign({ apiKey: '', model: 'claude-sonnet-5', enabled: true }, got.ai || {});
  }

  async function setAI(patch) {
    const cur = await getAI();
    await chrome.storage.local.set({ ai: Object.assign(cur, patch) });
  }

  /* ---------- mobile push (Web Push relay, see mobile-push/) ---------- */

  async function getPush() {
    const got = await chrome.storage.local.get({ push: null });
    return Object.assign({ on: false, serverUrl: '', code: '' }, got.push || {});
  }

  async function setPush(patch) {
    const cur = await getPush();
    await chrome.storage.local.set({ push: Object.assign(cur, patch) });
  }

  /* Fire-and-forget: a phone not being reachable should never block a desktop
     notification or throw inside the caller. */
  async function pushToPhone(title, body, url) {
    const cfg = await getPush();
    if (!cfg.on || !cfg.serverUrl || !cfg.code) return { ok: false, skipped: true };
    try {
      const base = cfg.serverUrl.replace(/\/+$/, '');
      const res = await fetch(base + '/api/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: cfg.code, title: title, body: body, url: url || '' })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) return { ok: false, error: (data && data.error) || ('HTTP ' + res.status) };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /* ---------- the Kanban board, same server as the phone relay ----------
     One board per pairing code, so the extension and the paired phone see
     the same cards. Requires Settings > Mobile notifications to be filled
     in even if push itself is switched off. */

  const BOARD_COLUMNS = [
    { id: 'inbox', label: 'Inbox' },
    { id: 'doing', label: 'Doing' },
    { id: 'action', label: 'Action Items' },
    { id: 'done', label: 'Done' }
  ];

  async function boardBase() {
    const cfg = await getPush();
    if (!cfg.serverUrl || !cfg.code) return null;
    return { base: cfg.serverUrl.replace(/\/+$/, ''), code: cfg.code };
  }

  async function boardApi(path, options) {
    const cx = await boardBase();
    if (!cx) throw new Error('Fill in the server address and pairing code in Settings first.');
    const res = await fetch(cx.base + path, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
    return { data: data, code: cx.code };
  }

  async function fetchCards() {
    const cx = await boardBase();
    if (!cx) throw new Error('Fill in the server address and pairing code in Settings first.');
    const { data } = await boardApi('/api/cards?code=' + encodeURIComponent(cx.code));
    return data.cards || [];
  }

  /* fields: { title, body, url, column, context, due, cardId, actorUser } —
     cardId/actorUser are Trello's shortLink + username, kept so a card can
     later be replied to (posting a comment needs a card to post to, and
     tagging the right person by default needs their username) without
     requiring the fuller Trello lookup the popup's queue has. */
  async function createCard(fields) {
    const cx = await boardBase();
    if (!cx) throw new Error('Fill in the server address and pairing code in Settings first.');
    const f = fields || {};
    const { data } = await boardApi('/api/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: cx.code, title: f.title, body: f.body || '', url: f.url || '',
        column: f.column || 'inbox', context: f.context || '', due: f.due || '',
        cardId: f.cardId || '', actorUser: f.actorUser || ''
      })
    });
    return data.card;
  }

  /* Fire-and-forget board logging: a missing/misconfigured server should
     never block the caller or throw, same spirit as pushToPhone. */
  async function fileCard(fields) {
    try {
      await createCard(Object.assign({ column: 'inbox' }, fields));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  async function moveCard(id, column) {
    const cx = await boardBase();
    const { data } = await boardApi('/api/cards/' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: cx.code, column: column })
    });
    return data.card;
  }

  /* general-purpose card edit — patch is any subset of
     {column, context, due, cardId, actorUser}. Used by the board's
     backfill pass to fill in fields an older card was filed without. */
  async function updateCard(id, patch) {
    const cx = await boardBase();
    const { data } = await boardApi('/api/cards/' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ code: cx.code }, patch || {}))
    });
    return data.card;
  }

  async function deleteCard(id) {
    const cx = await boardBase();
    await boardApi('/api/cards/' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: cx.code })
    });
  }

  /* Build the grounding context. Trello's structured notifications first, since
     that's the good data, then whatever the saved questions matched, then page text. */
  function buildContext(state) {
    const out = [];
    const page = (state && state.page) || {};
    out.push('TODAY: ' + new Date().toString());
    out.push('YOUR HANDLE / NAMES: @rafay10, @rafay, Rafay');
    out.push('CURRENT PAGE: ' + (page.title || '(untitled)') + ' — ' + (page.url || ''));

    const raw = state && state.trelloRaw;
    if (raw && raw.ok && (raw.items || []).length) {
      out.push('');
      out.push('YOUR TRELLO NOTIFICATIONS (newest first, straight from Trello — this is authoritative):');
      raw.items.slice(0, 80).forEach((n) => {
        const when = n.date ? new Date(n.date).toISOString().slice(0, 16).replace('T', ' ') : 'unknown time';
        out.push('- [' + when + ' | ' + n.type + (n.unread ? ' | UNREAD' : '') + '] ' +
          n.actor + ' on card "' + (n.cardName || '?') + '"' +
          (n.listName ? ' (list: ' + n.listName + ')' : '') +
          (n.boardName ? ' (board: ' + n.boardName + ')' : '') +
          (n.text ? ': "' + normalize(n.text).slice(0, 500) + '"' : '') +
          (n.shortLink ? ' [link: https://trello.com/c/' + n.shortLink + ']' : ''));
      });
    }

    const results = (state && state.results) || [];
    const matched = [];
    results.forEach((r) => {
      r.items.slice(0, 25).forEach((i) => {
        matched.push('- (' + r.rule.name + (i.isNew ? ' | NEW' : ' | already handled') + ') ' +
          (i.headline ? i.headline + ' — ' : '') + normalize(i.text).slice(0, 300) +
          (i.when ? ' [' + new Date(i.when).toISOString().slice(0, 16).replace('T', ' ') + ']' : ''));
      });
    });
    if (matched.length) {
      out.push('');
      out.push('ITEMS YOUR SAVED QUESTIONS MATCHED ON THIS PAGE:');
      out.push.apply(out, matched);
    }

    const blocks = (page.units && page.units.length ? page.units : page.blocks) || [];
    if (blocks.length) {
      out.push('');
      out.push('VISIBLE TEXT ON THE PAGE (may be truncated):');
      for (let i = 0; i < blocks.length; i++) {
        const t = normalize(blocks[i].text);
        if (t.length < 3) continue;
        out.push('- ' + t.slice(0, 240));
        if (out.join('\n').length > MAX_CONTEXT) { out.push('- …(truncated)'); break; }
      }
    }

    let ctx = out.join('\n');
    if (ctx.length > MAX_CONTEXT) ctx = ctx.slice(0, MAX_CONTEXT) + '\n…(truncated)';
    return ctx;
  }

  const AI_SYSTEM = [
    'You help a tax professional (Rafay, Trello handle @rafay10) keep track of what needs his attention.',
    'You will be given a CONTEXT block: his Trello notifications, items matched by his saved questions, and text from the page he is looking at.',
    'Rules:',
    '1. Answer ONLY from the CONTEXT. Never invent a card, person, date, or comment.',
    '2. If the answer is not in the CONTEXT, say so plainly and say what you would need (e.g. "open the notifications page" or "no comment in the last 7 days mentions that").',
    '3. Be brief and concrete. Name the card and the person. Quote the relevant fragment of a comment rather than paraphrasing it away.',
    '4. Distinguish being TAGGED in a comment (mentionedOnCard, or a commentCard whose text contains his handle) from merely being a card member or being added to a card.',
    '5. Prefer newest items. Use the TODAY value for relative dates like "today" or "this week", and give ages like "21h ago" where useful.',
    '6. Plain prose or short bullets. No preamble, no restating the question, no markdown headers.'
  ].join('\n');

  function aiErrorMessage(status, body) {
    if (status === 401 || status === 403) return 'Anthropic rejected the API key. Check it in Manage questions → Ask Claude.';
    if (status === 429) return 'Rate limited by Anthropic — wait a moment and ask again.';
    if (status === 400 && /credit|billing/i.test(body || '')) return 'Anthropic reports a billing problem on this key.';
    if (status === 529 || status === 503) return 'Anthropic is overloaded right now. Try again shortly.';
    return 'Anthropic API error ' + status + (body ? ': ' + String(body).slice(0, 200) : '');
  }

  async function askClaude(question, context, history) {
    const cfg = await getAI();
    if (!cfg.apiKey) {
      const e = new Error('No API key yet. Open Manage questions → Ask Claude and paste your Anthropic key.');
      e.needsKey = true;
      throw e;
    }
    const messages = [];
    (history || []).slice(-6).forEach((h) => messages.push({ role: h.role, content: h.content }));
    messages.push({
      role: 'user',
      content: 'CONTEXT (the only data you may use):\n' + context + '\n\nQUESTION: ' + question
    });

    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: cfg.model || 'claude-sonnet-5',
          max_tokens: 800,
          system: AI_SYSTEM,
          messages: messages
        })
      });
    } catch (e) {
      throw new Error('Could not reach the Anthropic API (offline?): ' + ((e && e.message) || e));
    }
    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch (e) {}
      throw new Error(aiErrorMessage(res.status, body));
    }
    const j = await res.json();
    const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
    return {
      text: text || '(empty answer)',
      usage: j.usage || {},
      model: j.model || cfg.model,
      sentChars: context.length
    };
  }

  /* ---------- daily board update ----------
     One short message, drafted from what's actually on the board right now —
     mainly which client cards (QTM codes) are in Doing / Action Items today —
     ready to copy and send to whoever wants to know what he's working on.
     Reuses the same Gemini key as "Sort mentions"; nothing is sent anywhere
     on its own — a scheduled run only fills the textarea and notifies him,
     same as the weekly follow-up draft does. */

  async function getDailyUpdate() {
    const got = await chrome.storage.sync.get({ dailyUpdate: null });
    return Object.assign({ recipient: 'Nestor', on: false, hour: 8, minute: 0 }, got.dailyUpdate || {});
  }

  async function setDailyUpdate(patch) {
    const cur = await getDailyUpdate();
    await chrome.storage.sync.set({ dailyUpdate: Object.assign(cur, patch) });
  }

  const DAILY_UPDATE_SYSTEM = [
    'You write a short daily work-status message for a tax professional to send to a colleague.',
    'You are given a snapshot of his Kanban board: cards grouped by column —',
    'Inbox (new, not yet started), Doing (actively being worked today), Action Items (needs a decision, a reply, or is blocked on someone else), Done (finished, listed only as a count).',
    'Each card shows a client/QTM name, sometimes a due date, and sometimes a NOTE — the actual comment or mention text for that card, and the only source of truth for what the task involves.',
    'Write ONE short message — a sentence or two of lead-in, then a list of the client/QTM names being worked on today (from Doing, plus anything in Action Items or due today/overdue worth flagging).',
    'For each name in that list, add a short clause (roughly 5-12 words) describing what the task actually is, written from its NOTE — e.g. "Dane Nakama — waiting on K-1s before finishing the projection." Read the NOTE and say what it means in your own words; do not just repeat it verbatim, and do not pad with filler if it is already short. If a card has no NOTE, list just the name with no invented description.',
    'Skip Done and Inbox entirely unless something there is due today or overdue.',
    'Never invent a client name, QTM code, due date, or task detail that is not in the data given. If there is nothing to report, say so plainly in one line.',
    'No markdown headers. One item per line, dash-prefixed. Plain text, the way a person would actually type a quick message.'
  ].join('\n');

  function buildDailyUpdateContext(cards) {
    const lines = ['TODAY: ' + new Date().toDateString()];
    BOARD_COLUMNS.forEach(function (col) {
      const items = (cards || []).filter(function (c) { return c.column === col.id; });
      if (col.id === 'done') {
        lines.push(col.label.toUpperCase() + ': ' + items.length + ' card(s) — not relevant to today\'s update.');
        return;
      }
      lines.push(col.label.toUpperCase() + (items.length ? ':' : ': (nothing here)'));
      items.forEach(function (c) {
        const name = c.context || c.title;
        const bits = [name];
        if (c.due) bits.push(c.due);
        lines.push('- ' + bits.join(' — '));
        const note = tidyCommentText(c.body || '').trim();
        if (note) lines.push('  NOTE: ' + note.slice(0, 500));
      });
    });
    return lines.join('\n');
  }

  /* Gemini, not Claude — reuses the same key as "Sort mentions into Needs
     me / Waiting / FYI" (getTriage), rather than asking for a second key. */
  async function draftDailyUpdate(cards, recipient) {
    const cfg = await getTriage();
    if (!cfg.apiKey) {
      const e = new Error('No Gemini key yet. Open Settings → Sort mentions and paste your Google AI Studio key.');
      e.needsKey = true;
      throw e;
    }
    const context = buildDailyUpdateContext(cards);
    const ask = recipient
      ? 'Address it to ' + recipient + ' by name (e.g. "Hi ' + recipient + ',").'
      : 'Open with a brief greeting, no specific name.';

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(cfg.model || 'gemini-flash-latest') + ':generateContent';

    let res;
    try {
      res = await fetchGeminiRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: DAILY_UPDATE_SYSTEM }] },
          contents: [{ role: 'user', parts: [{ text: ask + '\n\nBOARD SNAPSHOT:\n' + context }] }],
          /* Flash's default "thinking" tokens count against maxOutputTokens —
             at 400 the model could burn the whole budget reasoning and never
             get around to writing the update, so it came back half-written
             ("Here is what I am working on today along with" — then nothing).
             thinkingBudget: 0 turns that off; a status update doesn't need
             chain-of-thought. */
          generationConfig: { temperature: 0.4, maxOutputTokens: 1400, thinkingConfig: { thinkingBudget: 0 } }
        })
      });
    } catch (e) {
      throw new Error('Could not reach Gemini (offline?): ' + ((e && e.message) || e));
    }
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = (body && body.error && body.error.message) || '';
      } catch (e) { /* the status is enough */ }
      throw new Error(triageError(res.status, detail));
    }
    const body = await res.json();
    const candidate = (body.candidates || [])[0] || {};
    const parts = (candidate.content || {}).parts;
    const text = (parts || []).map(function (p) { return p.text || ''; }).join('\n').trim();
    if (candidate.finishReason === 'MAX_TOKENS') {
      throw new Error('Gemini\'s draft got cut off before it finished — hit Regenerate to try again.');
    }
    return { text: text || '(empty answer)', model: cfg.model };
  }

  /* ---------- weekly follow-up draft ----------
     Reads next week's calendar, finds each client's card, pulls the documents
     still outstanding on it, and drafts one message for the admin. Nothing is
     posted until you press send. */

  async function getFollowup() {
    const got = await chrome.storage.sync.get({ followup: null });
    return Object.assign(
      { on: true, weekday: 1, hour: 8, minute: 30, admin: 'pauleleazar1', gcalUser: 1,
        requireText: 'QTM', chaseDays: 1,
        wanted: ['organizer', 'paystubs', 'financials', 'return'],
        skipText: 'read.ai, read ai, readai, notetaker, meeting invite, invitation, booking, ' +
          'book a call, calendly, acuity, savvycal, chili piper, hubspot meeting, reschedule',
        maxMeetings: 20 },
      got.followup || {}
    );
  }

  async function setFollowup(patch) {
    const cur = await getFollowup();
    await chrome.storage.sync.set({ followup: Object.assign(cur, patch) });
  }

  /* Monday 00:00 to Sunday 23:59 of the coming week */
  function nextWeekRange(now) {
    const d = new Date(now || Date.now());
    d.setHours(0, 0, 0, 0);
    const dow = d.getDay();
    const toMonday = ((8 - dow) % 7) || 7;
    const start = new Date(d.getTime() + toMonday * 864e5);
    const end = new Date(start.getTime() + 7 * 864e5 - 1);
    return { start: start.getTime(), end: end.getTime() };
  }

  const GOOGLE_ACCOUNTS = [
    { index: 0, label: 'Rafay' },
    { index: 1, label: 'Dwight' },
    { index: 2, label: 'Justin' }
  ];

  function calendarUrl(ms, gcalUser) {
    const d = new Date(ms);
    const u = (typeof gcalUser === 'number' && gcalUser >= 0) ? gcalUser : 0;
    return 'https://calendar.google.com/calendar/u/' + u + '/r/week/' +
      d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
  }

  /* runs inside a Google Calendar tab */
  function extractCalendarEvents() {
    const out = [];
    const chips = [];
    const seen = {};
    const push = (label, eid, datekey) => {
      const t = (label || '').replace(/\s+/g, ' ').trim();
      if (t.length < 4 || t.length > 220) return;
      if (eid && !chips.some(function (c) { return c.eid === eid; })) {
        chips.push({ eid: eid, label: t, datekey: datekey || '' });
      }
      if (seen[t]) return;
      seen[t] = 1;
      out.push(t);
    };
    try {
      document.querySelectorAll('[data-eventid], [role="button"][aria-label], [role="gridcell"] [aria-label]')
        .forEach(function (el) {
          const l = el.getAttribute('aria-label') || el.textContent || '';
          const eid = el.getAttribute('data-eventid') ||
            (el.closest && el.closest('[data-eventid]') && el.closest('[data-eventid]').getAttribute('data-eventid')) || '';
          /* Google stamps every day column with its own date. That is a far more
             reliable answer to "which day is this?" than reading the label. */
          let dk = '';
          try {
            const col = el.closest && el.closest('[data-datekey]');
            dk = (col && col.getAttribute('data-datekey')) || '';
          } catch (e) {}
          if (/\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i.test(l) || el.hasAttribute('data-eventid')) push(l, eid, dk);
        });
    } catch (e) {}
    return { ok: true, labels: out, chips: chips, title: document.title, url: location.href };
  }

  /* Google packs a date into one integer per day column:
       ((year - 1970) << 9) | (month << 5) | day
     Decoded with a sanity check, so a format change gives us nothing rather than
     a wrong date. */
  function decodeDateKey(key) {
    const n = parseInt(key, 10);
    if (!n || n < 0) return null;
    const year = (n >> 9) + 1970;
    const month = (n >> 5) & 15;
    const day = n & 31;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    if (year < 2015 || year > 2100) return null;
    const d = new Date(year, month - 1, day);
    if (d.getMonth() !== month - 1 || d.getDate() !== day) return null;   // 31 Feb
    return d;
  }

  const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* Which day is this meeting on? The column's own datekey if we have it;
     otherwise a weekday name in the label, resolved inside the target week. */
  function meetingDate(event, chip, weekStart) {
    const fromKey = chip && chip.datekey ? decodeDateKey(chip.datekey) : null;
    if (fromKey) return fromKey;

    const name = String((event && event.day) || '').toLowerCase();
    const idx = DAYS.indexOf(name);
    if (idx === -1 || !weekStart) return null;
    const start = new Date(weekStart);
    start.setHours(0, 0, 0, 0);
    for (let i = 0; i < 7; i++) {
      const d = new Date(start.getTime() + i * 864e5);
      if (d.getDay() === idx) return d;
    }
    return null;
  }

  /* "Thu 6 Aug · 1pm–2pm" */
  function whenLabel(entry) {
    const bits = [];
    const ms = entry && entry.dateMs;
    if (ms) {
      const d = new Date(ms);
      bits.push(DAY_SHORT[d.getDay()] + ' ' + d.getDate() + ' ' + MONTH_SHORT[d.getMonth()]);
    } else if (entry && entry.day) {
      bits.push(entry.day);
    }
    if (entry && entry.time) bits.push(entry.time);
    return bits.join(' · ');
  }


  /* pair a parsed meeting back to the chip it came from */
  function chipForEvent(event, chips) {
    if (!event || !chips || !chips.length) return null;
    const want = String((event.raw || event.fullTitle || '')).toLowerCase();
    const exact = chips.filter(function (c) { return String(c.label).toLowerCase() === want; })[0];
    if (exact) return exact;
    const toks = (event.clientTokens || []).filter(function (t) { return t.length > 2; });
    const code = String(event.code || '').toLowerCase();
    const hits = chips.filter(function (c) {
      const l = String(c.label).toLowerCase();
      const nameHit = toks.some(function (t) { return l.indexOf(t) !== -1; });
      return nameHit && (!code || l.indexOf(code) !== -1);
    });
    return hits.length === 1 ? hits[0] : null;
  }

  const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const DAY_RE = new RegExp('\\b(' + DAYS.join('|') + ')\\b', 'i');
  const DAY_RE_G = new RegExp('\\b(' + DAYS.join('|') + ')\\b', 'gi');

  /* Real Google Calendar labels come in several shapes:
       "[QTM1] Taylor Jackson and Dwight Martinez"   (full title — best case)
       "Warren QTM2 Dwight Martinez 2026Warren QTM211am"  (title doubled, time glued)
       "11am To 12pm Warren QTM2 ..."                (time in front)
       "Canceled: [TPD] Justin ..."                  (must be skipped)
     So: pull the code, then clean everything that is not a name out of the rest. */

  const CODE_RE = /\b(QTM|TPR|TPD|CDP|CBP|UTM)\s?(\d?)/i;
  const BRACKET_CODE_RE = /\[\s*(QTM|TPR|TPD|CDP|CBP|UTM)\s?(\d?)\s*\]/i;

  /* on every event and never the client */
  const EVENT_NOISE = ('dwight martinez rafay justin zoom meet google calendar hangout invitation ' +
    'busy free all day no title no location going internal block standup team read ai ' +
    'canceled cancelled am pm to until and with x before after new event').split(' ');

  function cleanNameText(text) {
    return normalize(text)
      // times, in every shape they arrive
      .replace(/\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b/gi, ' ')
      .replace(/\b\d{1,2}(?::\d{2})?\s*(?:[–—-]|to|until)\s*\d{1,2}(?::\d{2})?\s?(?:am|pm)?\b/gi, ' ')
      .replace(/\b\d{1,2}:\d{2}\b/g, ' ')
      .replace(/\b\d{1,3}\s?(?:min|mins|minutes|hr|hrs|hour|hours)\b/gi, ' ')
      .replace(DAY_RE_G, ' ')
      .replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}\b/gi, ' ')
      .replace(/\b\d{4}\b/g, ' ')
      .replace(/\b(QTM|TPR|TPD|CDP|CBP|UTM)\s?\d?/gi, ' ')
      .replace(/[\[\]().,;:|]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function clientTokensFrom(text) {
    const noise = {};
    EVENT_NOISE.forEach(function (w) { noise[w] = 1; });
    return cleanNameText(text).toLowerCase()
      .replace(/[^\p{L}\p{N} ]/gu, ' ')
      .split(/\s+/)
      .filter(function (w) { return w.length > 1; })
      .filter(function (w) { return !noise[w]; })
      .filter(function (w) { return !/^\d+$/.test(w); })
      .filter(function (w) { return !/^(qtm|tpr|tpd|cdp|cbp|utm|q\d)\d*$/.test(w); });
  }

  function parseCalendarLabel(label) {
    const raw = normalize(label);
    if (!raw) return null;
    if (/^(create|search|settings|previous|next|today|calendar|week of|show|menu|main|jump)\b/i.test(raw)) return null;
    // a struck-through "Canceled:" event is not happening
    if (/\bcancell?ed\b/i.test(raw)) return null;

    const bracket = raw.match(BRACKET_CODE_RE);
    let code = '';
    let front = '';

    if (bracket) {
      // "[QTM1] Taylor Jackson and Dwight Martinez" — the name follows the bracket
      code = bracket[1].toUpperCase() + (bracket[2] || '');
      front = raw.slice(bracket.index + bracket[0].length);
      // cut at the organiser: "... and Dwight Martinez", "Nestor X Dwight"
      front = front.split(/\s+(?:and|with|x|&)\s+/i)[0];
      front = front.replace(/\bdwight\b[\s\S]*$/i, ' ');
    } else {
      const m = raw.match(CODE_RE);
      if (m) {
        code = m[1].toUpperCase() + (m[2] || '');
        front = raw.slice(0, m.index);          // "Warren", or "11am To 12pm Warren"
      } else {
        front = raw;
      }
    }

    const clientTokens = clientTokensFrom(front);

    // times: strip the codes first, since they arrive glued ("QTM211am")
    const rest = raw.replace(/\b(QTM|TPR|TPD|CDP|CBP|UTM)\s?\d?/gi, ' ');
    const rangeM = rest.match(/(\d{1,2}(?::\d{2})?\s?(?:am|pm)?)\s*(?:[–—-]|to|until)\s*(\d{1,2}(?::\d{2})?\s?(?:am|pm))/i);
    const timeM = rangeM || rest.match(/(\d{1,2}(?::\d{2})?\s?(?:am|pm))/i);
    const dayM = raw.match(DAY_RE);
    const dateM = raw.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})\b/i);

    const client = clientTokens.map(function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ');

    if (!client) return null;      // a code with no name is not actionable

    return {
      client: client,
      code: code,
      title: (client + (code ? ' ' + code : '')).trim(),
      clientTokens: clientTokens,
      fullTitle: !!bracket,        // bracketed events carry the fuller name
      time: timeM ? normalize(timeM[0]).replace(/\s*(?:[–—-]|to|until)\s*/i, '–') : '',
      day: dayM ? dayM[1][0].toUpperCase() + dayM[1].slice(1).toLowerCase() : '',
      date: dateM ? normalize(dateM[0]) : '',
      raw: raw
    };
  }

  /* the same client shows up twice — "[QTM1] Taylor Jackson…" and "Taylor QTM1".
     Keep the richer one so we never comment on a card twice. */
  function dedupeEvents(events) {
    const byKey = {};
    (events || []).forEach(function (ev) {
      const first = (ev.clientTokens || [])[0] || ev.client.toLowerCase();
      const key = (ev.code || '') + '|' + first;
      const prev = byKey[key];
      if (!prev) { byKey[key] = ev; return; }
      const better =
        (ev.clientTokens.length > prev.clientTokens.length) ||
        (ev.clientTokens.length === prev.clientTokens.length && ev.fullTitle && !prev.fullTitle) ||
        (!prev.time && ev.time);
      if (better) {
        // keep whichever detail the other one had
        if (!ev.time && prev.time) ev.time = prev.time;
        if (!ev.day && prev.day) ev.day = prev.day;
        byKey[key] = ev;
      } else {
        if (!prev.time && ev.time) prev.time = ev.time;
        if (!prev.day && ev.day) prev.day = ev.day;
      }
    });
    return Object.keys(byKey).map(function (k) { return byKey[k]; });
  }

  /* the code written on a card, e.g. "[QTM2] Gary Warner" -> "QTM2" */
  function cardCode(name) {
    const m = String(name || '').match(CODE_RE);
    return m ? (m[1].toUpperCase() + (m[2] || '')) : '';
  }

  /* Only certain meetings matter for follow-ups. Everything else on the calendar —
     dentists, internal calls, other work — is ignored outright. */
  function eventMatchesRequired(ev, requireText) {
    const need = String(requireText || '').split(',').map(function (w) { return w.trim(); }).filter(Boolean);
    if (!need.length) return true;
    const hay = ((ev && (ev.raw || ev.title)) || '').toLowerCase();
    return need.some(function (w) { return hay.indexOf(w.toLowerCase()) !== -1; });
  }

  /* Notetakers, booking links and invite chatter are never client meetings. */
  function eventIsSkipped(ev, skipText) {
    const skip = String(skipText || '').split(',').map(function (w) { return w.trim().toLowerCase(); }).filter(Boolean);
    if (!skip.length) return false;
    const hay = ((ev && (ev.raw || ev.title)) || '').toLowerCase();
    return skip.some(function (w) { return hay.indexOf(w) !== -1; });
  }

  /* Trello search, run as the page */
  function searchTrelloCards(query) {
    return (async () => {
      try {
        const url = 'https://trello.com/1/search?query=' + encodeURIComponent(query) +
          '&modelTypes=cards&cards_limit=8&card_fields=name,shortLink,idBoard,due&partial=true';
        const res = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        if (!res.ok) return { ok: false, status: res.status };
        const j = await res.json();
        return { ok: true, cards: (j && j.cards) || [] };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    })();
  }

  /* the documents still outstanding on a card */
  function fetchCardChecklists(cardId) {
    return (async () => {
      try {
        const res = await fetch('https://trello.com/1/cards/' + encodeURIComponent(cardId) +
          '/checklists?fields=name&checkItem_fields=name,state',
          { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        if (!res.ok) return { ok: false, status: res.status };
        const j = await res.json();
        const open = [];
        let total = 0;
        (Array.isArray(j) ? j : []).forEach(function (cl) {
          (cl.checkItems || []).forEach(function (it) {
            total++;
            if (it.state !== 'complete') open.push((it.name || '').replace(/\s+/g, ' ').trim());
          });
        });
        return { ok: true, missing: open, total: total, done: total - open.length };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    })();
  }

  /* ---------- what has already happened on this card? ----------
     The card's own comments are a better record than my sent mail: Paul writes
     what he chased and when, and what came back. Reading them means each comment
     can say what is actually still outstanding and how many times it has been
     asked for, instead of the same four bullets every week. Nothing extra is
     fetched for this — these are the comments already read for the guard above. */

  const DOC_TALK = {
    organizer: /organi[sz]er|questionnaire|intake\s*form|\bq\d\s*form\b|tax\s*plan\s*form/i,
    /* "payroll" used to live in here, so "payroll returns are in" credited the
       PAYSTUBS as received. They are different documents — a 941 is not a
       paystub — and confusing them means telling him a client sent something
       they did not. */
    paystubs: /pay\s?stubs?|paystubs?|\bw-?2\b/i,
    payroll: /payroll\s*(?:returns?|filings?|reports?)|\b9(?:40|41)\b|quarterly\s*payroll/i,
    financials: /financials?|\bp\s*&?\s*l\b|profit\s*(?:and|&)\s*loss|balance\s*sheet|\bbs\b|bookkeeping|\bqbo\b/i,
    return: /\b(?:1120s?|1065|1040)\b|tax\s*returns?|prior\s*year\s*return/i
  };

  /* "the organizer arrived, thanks" was read as still outstanding, because
     "arrived" was missing from this list — so a draft would keep chasing a
     document someone had already said was in. Found while building the ledger. */
  const GOT_IT = /\b(uploaded|upload(?:ed)? to|received|receiv'?d|attached|arrived|came in|has come in|come through|turned up|sorted|saved|added|provided|shared|sent (?:it|them|these|those|over|through)|signed|completed|filled|done|in hand|on file|got (?:it|them|these))\b|\b(?:is|are|'re)\s+in\b(?!\s*(?:progress|the\s*works|transit|review|question))/i;
  const NOT_YET = /\b(not|never|no|none|hasn'?t|haven'?t|hadn'?t|didn'?t|isn'?t|aren'?t|won'?t|can'?t|still|yet|pending|awaiting|await|waiting|missing|outstanding|chase|chasing|need|needs|needed|require[sd]?)\b/i;
  const CHASED = /\b(follow(?:ed|ing)?\s*up|chased?|chasing|reminder|reminded|remind|emailed|e-mailed|mailed|requested|request|asked|asking|reach(?:ed)?\s*out|pinged|nudged|sent (?:a|an|the|another) (?:email|reminder|request|note))\b/i;
  const PROMISED = /\b(will send|will upload|will get|will have|said (?:he|she|they)|says (?:he|she|they)|promised|by (?:tomorrow|monday|tuesday|wednesday|thursday|friday|the weekend|next week|end of)|on (?:holiday|vacation|leave|pto)|out of (?:office|town)|travelling|traveling|working on)\b/i;

  function shortDate(ms) {
    if (!ms) return '';
    const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const key = dayKeyIn(ms);                 // the firm's day, not this machine's
    const bits = key.split('-');
    return String(+bits[2]) + ' ' + M[+bits[1] - 1];
  }

  /* Split a comment into small enough pieces that "paystubs are in, still no
     organizer" cannot be read as both documents being in. */
  function segments(text) {
    return String(text || '')
      .split(/[\n;.!?]+|,\s+(?=(?:still|but|and\s+(?:still|no|not)|no\b|not\b|awaiting|waiting))/i)
      .map(function (s) { return s.replace(/\s+/g, ' ').trim(); })
      .filter(function (s) { return s.length > 2; });
  }

  function stanceOf(seg) {
    const got = GOT_IT.test(seg);
    const neg = NOT_YET.test(seg);
    if (got && !neg) return 'received';
    if (PROMISED.test(seg)) return 'promised';
    if (CHASED.test(seg) || neg) return 'chased';
    return '';
  }

  /* Per document: has it come in, been promised, or been asked for — and how
     often. Later comments win over earlier ones. */
  function readCardHistory(comments, opts) {
    const o = opts || {};
    const admin = String(o.admin || '').replace(/^@/, '').toLowerCase();
    const list = (comments || []).slice().sort(function (a, b) { return (a.at || 0) - (b.at || 0); });

    const byDoc = {};
    Object.keys(DOC_TALK).forEach(function (k) { byDoc[k] = { state: '', at: 0, chases: 0, quote: '', by: '' }; });
    let generic = 0;
    let lastAt = 0;

    list.forEach(function (c) {
      if (!c || !c.text) return;
      lastAt = Math.max(lastAt, c.at || 0);
      let namedAny = false;

      segments(c.text).forEach(function (seg) {
        const stance = stanceOf(seg);
        if (!stance) return;
        Object.keys(DOC_TALK).forEach(function (id) {
          if (!DOC_TALK[id].test(seg)) return;
          namedAny = true;
          const rec = byDoc[id];
          if (stance === 'chased') rec.chases++;
          // a later comment overrides, except that "received" is not undone by a
          // fresh generic ask in the same breath
          if (stance === 'received' || rec.state !== 'received') {
            rec.state = stance;
            rec.at = c.at || rec.at;
            rec.quote = seg.slice(0, 160);
            rec.by = c.byName || c.by || '';
          }
        });
      });

      // "@paul please chase the client" with no document named
      if (!namedAny && admin && c.text.toLowerCase().indexOf('@' + admin) !== -1) generic++;
    });

    const received = Object.keys(byDoc).filter(function (k) { return byDoc[k].state === 'received'; });

    /* The most recent note from someone other than me — usually the admin saying
       what he did. Quoting it back makes each message about that client, instead
       of the same four bullets with a different name on top. */
    const mine = (o.usernames || MY_USERNAMES).map(function (u) { return String(u).toLowerCase(); });
    let lastNote = null;
    list.forEach(function (c) {
      if (!c || !c.text) return;
      if (c.by && mine.indexOf(c.by) !== -1) return;
      if (!lastNote || (c.at || 0) > (lastNote.at || 0)) {
        lastNote = { at: c.at, by: c.byName || c.by, text: c.text };
      }
    });

    /* how long the oldest still-outstanding ask has been outstanding */
    let oldestAsk = 0;
    Object.keys(byDoc).forEach(function (k) {
      const r = byDoc[k];
      if (r.state === 'received' || !r.at) return;
      if (!oldestAsk || r.at < oldestAsk) oldestAsk = r.at;
    });

    return {
      byDoc: byDoc, received: received, generic: generic, lastAt: lastAt,
      lastNote: lastNote, oldestAsk: oldestAsk,
      comments: list.length,
      known: Object.keys(byDoc).some(function (k) { return byDoc[k].state; }) || generic > 0
    };
  }

  function daysBetween(a, b) {
    if (!a) return 0;
    return Math.max(0, Math.round(((b || Date.now()) - a) / 864e5));
  }

  /* the tail added to one bullet, from that document's own history */
  function askNote(rec) {
    if (!rec || !rec.state) return '';
    const when = rec.at ? shortDate(rec.at) : '';
    if (rec.state === 'promised') {
      return when ? ' — they said they would send it (' + when + ')' : ' — they said they would send it';
    }
    if (rec.chases >= 3) return ' — asked ' + rec.chases + ' times already' + (when ? ', last on ' + when : '') + ', still nothing';
    if (rec.chases === 2) return ' — asked twice already' + (when ? ', last on ' + when : '') + ', still nothing';
    if (rec.chases === 1) return ' — asked once already' + (when ? ' on ' + when : '');
    return '';
  }

  /* ---------- have I already chased this card? ----------
     Posting the same "@admin please chase the client" comment twice in a day is
     worse than useless — it trains the admin to ignore the card. So before we
     draft anything we read the card's own comments and see whether I already
     asked, and when. */

  /* Checklists and comments in ONE request instead of two. Same information,
     half the round trips — this is most of the rebuild time. */
  function fetchCardBundle(cardId) {
    return (async () => {
      try {
        const res = await fetch('https://trello.com/1/cards/' + encodeURIComponent(cardId) +
          '?fields=name,shortLink' +
          '&checklists=all&checklist_fields=name&checkItem_fields=name,state' +
          '&actions=commentCard&actions_limit=50&action_memberCreator_fields=username,fullName',
          { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        if (!res.ok) return { ok: false, status: res.status };
        const j = await res.json();

        const open = [];
        let total = 0;
        (Array.isArray(j.checklists) ? j.checklists : []).forEach(function (cl) {
          (cl.checkItems || []).forEach(function (it) {
            total++;
            if (it.state !== 'complete') open.push(String(it.name || '').replace(/\s+/g, ' ').trim());
          });
        });

        const comments = (Array.isArray(j.actions) ? j.actions : [])
          .filter(function (a) { return a && a.type === 'commentCard'; })
          .map(function (a) {
            return {
              at: Date.parse((a && a.date) || '') || 0,
              by: ((a && a.memberCreator && a.memberCreator.username) || '').toLowerCase(),
              byName: (a && a.memberCreator && a.memberCreator.fullName) || '',
              text: String((a && a.data && a.data.text) || '').replace(/\s+/g, ' ').trim()
            };
          });

        return { ok: true, missing: open, total: total, done: total - open.length, comments: comments };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    })();
  }

  function fetchCardComments(cardId) {
    return (async () => {
      try {
        const res = await fetch('https://trello.com/1/cards/' + encodeURIComponent(cardId) +
          '/actions?filter=commentCard&limit=40&memberCreator_fields=username,fullName',
          { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        if (!res.ok) return { ok: false, status: res.status };
        const j = await res.json();
        /* NB: this runs inside the Trello page, so it cannot call anything from
           this file's scope — the whitespace tidy has to be inline. */
        const list = (Array.isArray(j) ? j : []).map(function (a) {
          return {
            at: Date.parse((a && a.date) || '') || 0,
            by: ((a && a.memberCreator && a.memberCreator.username) || '').toLowerCase(),
            byName: (a && a.memberCreator && a.memberCreator.fullName) || '',
            text: String((a && a.data && a.data.text) || '').replace(/\s+/g, ' ').trim()
          };
        });
        return { ok: true, comments: list };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    })();
  }

  /* my own Trello usernames, taken from the identity list at the top */
  const MY_USERNAMES = ME
    .filter(function (m) { return /^@/.test(m); })
    .map(function (m) { return m.slice(1).toLowerCase(); });

  /* Comments I wrote that tag the admin about documents. Anything else on the
     card — the admin's own updates, other people's chatter — is not a chase. */
  function myChases(comments, admin, opts) {
    const o = opts || {};
    const handle = String(admin || '').replace(/^@/, '').toLowerCase();
    const mine = (o.usernames || MY_USERNAMES).map(function (u) { return String(u).toLowerCase(); });
    const out = [];
    (comments || []).forEach(function (c) {
      if (!c || !c.text) return;
      const byMe = !c.by || mine.indexOf(c.by) !== -1;
      if (!byMe) return;
      if (handle && c.text.toLowerCase().indexOf('@' + handle) === -1) return;
      if (!handle && !/@/.test(c.text)) return;
      out.push(c);
    });
    out.sort(function (a, b) { return b.at - a.at; });
    return out;
  }

  /* Was one of those chases recent enough that another would be noise?
     "today" means the same calendar day, not 24 rolling hours — a comment at
     9am yesterday and one at 8am today are two different days of chasing. */
  function chaseState(comments, admin, opts) {
    const o = opts || {};
    const now = o.now || Date.now();
    const days = o.days == null ? 1 : o.days;
    const list = myChases(comments, admin, o);
    if (!list.length) return { chased: false, count: 0 };

    const last = list[0];
    let recent;
    if (days <= 1) {
      const a = new Date(now); const b = new Date(last.at);
      recent = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    } else {
      recent = (now - last.at) < days * 864e5;
    }
    return {
      chased: recent,
      count: list.length,
      lastAt: last.at,
      lastText: last.text,
      ago: ago(last.at, now),
      all: list.map(function (c) { return { at: c.at, text: c.text }; })
    };
  }

  /* NB: there is exactly ONE ago() in this file. There were briefly two, and
     because function declarations hoist, the second silently won — so every
     "how long ago" that passed an explicit clock was quietly wrong. */

  const NAME_STOP = ('call meeting consult consultation zoom google meet review tax plan planning session ' +
    'client with and the for followup follow discussion discuss catch check intro onboarding appointment').split(' ');

  function nameTokens(s) {
    const stop = {};
    NAME_STOP.forEach(function (w) { stop[w] = 1; });
    return normalize(s).toLowerCase()
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/[^\p{L}\p{N} ]/gu, ' ')
      .split(/\s+/)
      .filter(function (w) { return w.length > 2 && !stop[w]; })
      .filter(function (w) { return !/^(qtm|tpr|tpd|cdp|cbp|utm)\d*$/.test(w); });
  }

  /* Which card is this meeting about?
     A single first name is not enough on its own — but a first name plus the same
     QTM code is, because that pair is unique in practice. If two cards tie, say so
     rather than guessing at a client's card. */
  function bestCardForEvent(event, cards) {
    const ev = (typeof event === 'string') ? { client: event, clientTokens: nameTokens(event), code: '' } : (event || {});
    const et = (ev.clientTokens && ev.clientTokens.length) ? ev.clientTokens : nameTokens(ev.client || '');
    if (!et.length) return null;
    const evCode = (ev.code || '').toUpperCase();

    const scored = [];
    (cards || []).forEach(function (c) {
      const ct = nameTokens(c.name);
      if (!ct.length) return;
      let hits = 0;
      et.forEach(function (t) { if (ct.indexOf(t) !== -1) hits++; });
      if (!hits) return;

      const cCode = cardCode(c.name);
      const codeMatch = !!(evCode && cCode && evCode === cCode);
      const codeClash = !!(evCode && cCode && evCode !== cCode);
      if (codeClash) return;                    // Mario QTM1 must not land on a QTM3 card

      // a lone first name only counts when the code agrees
      if (hits < 2 && et.length > 1 && !codeMatch) return;
      if (hits < 1) return;
      if (et.length === 1 && !codeMatch) return;

      let score = hits * 2 + (hits === et.length ? 2 : 0) + (codeMatch ? 3 : 0);
      scored.push({ card: c, score: score, hits: hits, codeMatch: codeMatch });
    });

    if (!scored.length) return null;
    scored.sort(function (a, b) { return b.score - a.score; });
    const top = scored[0];
    const ties = scored.filter(function (x) { return x.score === top.score; });
    if (ties.length > 1) {
      return { card: null, ambiguous: ties.map(function (t) { return t.card; }), score: top.score, hits: top.hits };
    }
    return top;
  }

  function draftLineFor(entry) {
    const when = [entry.day, entry.time].filter(Boolean).join(' ');
    const head = '• ' + entry.client + (when ? ' — ' + when : '') +
      (entry.cardName ? '  ' + (/^\s*\[/.test(entry.cardName) ? entry.cardName : '[' + entry.cardName + ']') : '');
    if (!entry.cardId) return head + '\n  (no matching card found)';
    if (!entry.missing || !entry.missing.length) {
      return head + '\n  Nothing outstanding' + (entry.total ? ' (' + entry.done + '/' + entry.total + ' done)' : '');
    }
    return head + '\n  Still missing: ' + entry.missing.slice(0, 8).join(', ') +
      (entry.missing.length > 8 ? ' (+' + (entry.missing.length - 8) + ' more)' : '');
  }



  /* The card checklists hold everything — internal prep steps, master data, QBO
     access, three years of returns, each listed several times. Only four things
     are ever actually chased from the client, so collapse to those. */
  const WANTED_DOCS = [
    {
      id: 'organizer',
      label: 'Tax Plan Organizer (the questionnaire)',
      re: /organi[sz]er|questionnaire|intake\s*form/i
    },
    {
      id: 'paystubs',
      label: 'Year-to-date paystubs',
      re: /pay\s?stubs?|paystubs?|\bw-?2\b/i
    },
    {
      id: 'payroll',
      label: 'Payroll returns',
      re: /payroll\s*(?:returns?|filings?|reports?)|\b9(?:40|41)\b/i,
      detail: '941s / 940 as applicable'
    },
    {
      id: 'financials',
      label: 'Year-to-date financials (P&L and balance sheet)',
      re: /financials?|p\s*&\s*l\b|profit\s*(?:and|&)\s*loss|balance\s*sheet/i
    },
    {
      id: 'return',
      label: "Last year's tax return",
      re: /\b(?:1120s?|1065|1040)\b|tax\s*return/i,
      detail: '1120 / 1065 / 1040 as applicable'
    }
  ];

  function wantedCategories(ids) {
    const on = (ids && ids.length) ? ids : WANTED_DOCS.map(function (d) { return d.id; });
    return WANTED_DOCS.filter(function (d) { return on.indexOf(d.id) !== -1; });
  }

  /* Turn a long checklist into the short list of client asks.
     Returns { asks: [{id,label,detail,examples}], relevant: n, hidden: n } */
  function relevantAsks(missing, ids, satisfied) {
    const already = satisfied || [];
    const cats = wantedCategories(ids).filter(function (c) { return already.indexOf(c.id) === -1; });
    const seenItem = {};
    const items = (missing || []).filter(function (m) {
      const k = normalize(m).toLowerCase();
      if (!k || seenItem[k]) return false;   // the same doc is listed on several checklists
      seenItem[k] = 1;
      return true;
    });

    const asks = [];
    let relevant = 0;
    cats.forEach(function (cat) {
      const hits = items.filter(function (m) { return cat.re.test(m); });
      if (!hits.length) return;
      relevant += hits.length;
      asks.push({
        id: cat.id,
        label: cat.label,
        detail: cat.detail || '',
        examples: hits.slice(0, 4)
      });
    });

    return {
      asks: asks, relevant: relevant, hidden: Math.max(0, items.length - relevant),
      deduped: items.length, satisfied: already
    };
  }

  /* One message per card — Paul works card by card, so a single summary on one
     client's card is no use to him. */
  function buildCardMessage(entry, admin, wantedIds) {
    const at = admin ? '@' + String(admin).replace(/^@/, '') + ' ' : '';

    /* what the card's own comments say has already come in */
    const hist = entry.history || null;
    const fromCard = (hist && hist.received) || [];

    const found = relevantAsks(entry.missing, wantedIds, fromCard);

    if (!found.asks.length) {
      return at + 'Nothing outstanding from the client' +
        (fromCard.length ? ' — the comments here say it has all come in' : '') +
        (found.hidden && !fromCard.length ? ' (' + found.hidden + ' internal checklist items left, nothing to chase)' : '') +
        '. No follow-up needed.';
    }

    /* Blank line before the list, or Trello runs every bullet into one paragraph */
    const notes = found.asks.map(function (a) {
      return askNote(hist && hist.byDoc ? hist.byDoc[a.id] : null);
    });
    /* If every item carries the same note, saying it four times is noise — say it
       once under the list instead. */
    const allSame = notes.length > 1 && notes[0] && notes.every(function (n) { return n === notes[0]; });
    const lines = found.asks.map(function (a, i) {
      return '- ' + a.label + (a.detail ? ' (' + a.detail + ')' : '') + (allSame ? '' : notes[i]);
    });
    const sharedNote = allSame ? 'All of these were ' + notes[0].replace(/^\s*—\s*/, '') + '.' : '';

    const gotLines = [];
    if (fromCard.length) {
      gotLines.push('Already noted on this card: ' + docLabels(fromCard).join(', ') +
        (hist.byDoc[fromCard[0]] && hist.byDoc[fromCard[0]].at ? ' (' + shortDate(hist.byDoc[fromCard[0]].at) + ').' : '.'));
    }

    /* Where this client actually stands — the part that differs card to card */
    if (hist && hist.oldestAsk) {
      const d = daysBetween(hist.oldestAsk);
      if (d >= 7) {
        gotLines.push('Outstanding since ' + shortDate(hist.oldestAsk) + ' — ' + d + ' days now.');
      }
    }
    if (hist && hist.lastNote && hist.lastNote.text) {
      const q = hist.lastNote.text.length > 180 ? hist.lastNote.text.slice(0, 180) + '…' : hist.lastNote.text;
      gotLines.push('Last note here (' + shortDate(hist.lastNote.at) + '): “' + q + '”');
    }

    /* count from the notes, not the rendered lines — the notes may have been
       collapsed into one shared sentence below the list */
    const chased = notes.filter(function (n) { return /asked (?:twice|once|\d+ times)/.test(n); }).length;
    const opener = chased === found.asks.length && chased > 1
      ? 'Still outstanding after chasing — could you get these from the client:'
      : 'Could you follow up with the client for:';

    return at + opener + '\n\n' + lines.join('\n') +
      (sharedNote ? '\n\n' + sharedNote : '') +
      (gotLines.length ? '\n\n' + gotLines.join('\n') : '') +
      '\n\nThanks!';
  }

  /* "paystubs" -> "Year-to-date paystubs" */
  function docLabels(ids) {
    return (ids || []).map(function (id) {
      const d = WANTED_DOCS.filter(function (x) { return x.id === id; })[0];
      return d ? d.label.replace(/\s*\(.*$/, '') : id;
    });
  }

  /* include it in the send-all by default only if there is something to chase
     AND I have not already chased it in the window. A second identical comment
     on the same day is noise, so it stays unticked unless you tick it. */
  function shouldSendByDefault(entry, wantedIds) {
    if (!entry || !entry.cardId) return false;
    if (entry.chase && entry.chase.chased) return false;
    const fromCard = (entry.history && entry.history.received) || [];
    const have = fromCard;
    return relevantAsks(entry.missing, wantedIds, have).asks.length > 0;
  }

  function buildFollowupText(entries, admin) {
    const at = admin ? '@' + String(admin).replace(/^@/, '') + ' ' : '';
    const lines = [at + "Follow-ups for next week's meetings — please chase the client for anything still missing:", ''];
    (entries || []).forEach(function (e) { lines.push(draftLineFor(e)); });
    lines.push('');
    lines.push('Thanks!');
    return lines.join('\n');
  }

  /* ---------- storage ---------- */

  async function getRules() {
    const got = await chrome.storage.sync.get({ rules: null });
    if (!got.rules) {
      await chrome.storage.sync.set({ rules: DEFAULT_RULES });
      return DEFAULT_RULES.slice();
    }
    return got.rules;
  }

  async function setRules(rules) {
    await chrome.storage.sync.set({ rules: rules });
  }

  async function getSnapshots() {
    const got = await chrome.storage.local.get({ snapshots: {} });
    return got.snapshots || {};
  }

  async function markSeen(results) {
    const snaps = await getSnapshots();
    const now = Date.now();
    results.forEach((r) => {
      const snap = snaps[r.snapKey] || { hashes: {}, lastChecked: 0 };
      r.items.forEach((i) => { if (!snap.hashes[i.hash]) snap.hashes[i.hash] = now; });
      // keep snapshots from growing forever
      const keys = Object.keys(snap.hashes);
      if (keys.length > 1200) {
        keys.sort((a, b) => snap.hashes[a] - snap.hashes[b]).slice(0, keys.length - 1200)
          .forEach((k) => delete snap.hashes[k]);
      }
      snap.lastChecked = now;
      snaps[r.snapKey] = snap;
      r.items.forEach((i) => { i.isNew = false; });
      r.newCount = 0;
      r.neverChecked = false;
      r.lastChecked = now;
    });
    await chrome.storage.local.set({ snapshots: snaps });
  }

  /* dismiss (or un-dismiss) a single item — this is what makes the list behave
     like an inbox: you click it, it's gone, and it never comes back unless the
     underlying text changes. */
  async function setItemsSeen(snapKey, hashes, seen) {
    const snaps = await getSnapshots();
    const snap = snaps[snapKey] || { hashes: {}, lastChecked: 0 };
    const now = Date.now();
    (hashes || []).forEach((h) => {
      if (seen) { if (!snap.hashes[h]) snap.hashes[h] = now; }
      else { delete snap.hashes[h]; }
    });
    snap.lastChecked = now;
    snaps[snapKey] = snap;
    await chrome.storage.local.set({ snapshots: snaps });
  }

  async function forgetPage(results) {
    const snaps = await getSnapshots();
    results.forEach((r) => { delete snaps[r.snapKey]; });
    await chrome.storage.local.set({ snapshots: snaps });
  }

  /* ---------- run against a tab ---------- */

  async function getRangeMode() {
    const got = await chrome.storage.sync.get({ rangeMode: 'today' });
    return got.rangeMode || 'today';
  }

  /* Your Trello mentions on their own, with no page involved at all. This is what
     makes the panel work on a chrome:// page, the new tab page, or any site that
     has nothing to do with Trello. */
  async function mentionsOnly(opts) {
    const rules = await getRules();
    const mentionRule = rules.filter((r) => r.id === 'r_tagged_me')[0];
    if (mentionRule && !mentionRule.enabled) return { page: null, results: [], mentionsOnly: true };

    const mode = (opts && opts.rangeMode) || (await getRangeMode());
    const range = rangeFor(mode);
    const snapshots = await getSnapshots();
    const win = { sinceMs: range.since(), untilMs: range.until ? range.until() : 0 };

    let resp = null;
    try {
      resp = await notificationsAnywhere((opts && opts.tabId) || 0);
    } catch (e) {
      resp = { ok: false, error: (e && e.message) || 'could not reach Trello' };
    }
    const mem = await getMemory();
    const trello = trelloResults(resp, snapshots, {
      sinceMs: win.sinceMs, untilMs: win.untilMs,
      names: (mentionRule && mentionRule.names) || undefined,
      trustTrelloRead: mem.trustTrelloRead
    });
    return {
      page: { url: (opts && opts.url) || '', title: '', blocks: [], links: [] },
      results: [trello],
      mentionsOnly: true,
      trelloHow: resp && resp.how,
      trelloError: (resp && !resp.ok && resp.error) || ''
    };
  }

  async function runScan(tabId, url, opts) {
    const rules = await getRules();
    const applicable = rules.filter((r) => r.enabled && siteMatches(r, url || ''));
    const mentionRule0 = rules.filter((r) => r.id === 'r_tagged_me')[0];
    const wantMentions = !mentionRule0 || mentionRule0.enabled;
    /* Mentions do not depend on this page, so "no rules match this site" must not
       stop them — that is why the panel used to go blank away from Trello. */
    if (!applicable.length && !wantMentions) {
      return { page: { url: url, title: '', blocks: [], links: [] }, results: [], noRules: true };
    }

    const mode = (opts && opts.rangeMode) || (await getRangeMode());
    const range = rangeFor(mode);

    let page = null;
    let pageError = '';
    try {
      const injected = await chrome.scripting.executeScript({
        target: { tabId: tabId, allFrames: false },
        func: extractPage
      });
      page = injected && injected[0] && injected[0].result;
    } catch (e) {
      pageError = (e && e.message) || 'Chrome blocks extensions on this page';
    }
    if (!page) {
      /* unreadable page: carry on with an empty one so the mentions still arrive */
      if (!wantMentions) throw new Error(pageError || 'Could not read this page.');
      page = { url: url, title: '', blocks: [], links: [], labels: [], units: [] };
      pageError = pageError || 'Chrome blocks extensions on this page';
    }
    const snapshots = await getSnapshots();
    const win = { sinceMs: range.since(), untilMs: range.until ? range.until() : 0 };
    const results = scan(page, rules, snapshots, win);

    /* On Trello, don't rely on the page at all — ask Trello for your own
       mentions. Works identically on a board, a card, or the notifications page. */
    let trello = null;
    let trelloRawResp = null;
    const mentionRule = rules.filter((r) => r.id === 'r_tagged_me')[0];
    if (!mentionRule || mentionRule.enabled) {
      try {
        trelloRawResp = await notificationsAnywhere(isTrello(url) ? tabId : 0);
        const mem2 = await getMemory();
        trello = trelloResults(trelloRawResp, snapshots, {
          sinceMs: win.sinceMs, untilMs: win.untilMs,
          names: (mentionRule && mentionRule.names) || undefined,
          trustTrelloRead: mem2.trustTrelloRead
        });
      } catch (e) {
        trello = trelloResults({ ok: false, error: (e && e.message) || 'blocked' }, snapshots, win);
      }
    }

    let merged = results;
    if (trello && !trello.failed) {
      // Trello's own answer replaces the page-scraped version of the same question
      merged = [trello].concat(results.filter((r) => r.rule.id !== 'r_tagged_me'));
    } else if (trello && trello.failed) {
      merged = results.slice();
      merged.unshift(trello);
    }

    return {
      page: page, results: merged, range: range, trello: trello, trelloRaw: trelloRawResp,
      noRules: false, pageError: pageError, trelloHow: trelloRawResp && trelloRawResp.how
    };
  }

  function newId() {
    return 'r_' + Math.random().toString(36).slice(2, 9);
  }

  function ago(ts, now) {
    if (!ts) return 'never';
    const s = Math.floor(((now || Date.now()) - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  return {
    BUILTINS, DEFAULT_RULES, ME, MY_INITIALS, peopleIn, hash, normalize, urlKey, globToRegex, siteMatches,
    extractPage, candidateItems, pageMembers, ruleHits, scan, RANGES, rangeFor, getRangeMode,
    setCustomDate, getCustomDate, customDateLabel,
    fetchTrelloNotifications, trelloResults, isTrello, TRELLO_SNAPKEY,
    isCanopy, readCanopyPage, canopyRead, canopyDump, dumpPage,
    isGmail, gmailRead, buildGmailContext, answerAboutGmail,
    postTrelloComment, replyToCard, replyErrorMessage, QUICK_REPLIES,
    MAX_IMAGE_BYTES, imageAttachError, pickImageFromTransfer, pickImageFromClipboard, uploadTrelloAttachment,
    REACTIONS, findCommentAction, postTrelloReaction, reactToMention, reactErrorMessage,
    openCardInPlace, cardIsOpen, openCardSmart,
    NOTIF_URL, NOTIF_QS, shapeNotifications, notificationsAnywhere,
    pickDue, fetchCardDue, dueLabel, inTrelloTab, dueForCard, fetchCardDetails, cardDetailsFor, cardWholeFor, tidyCommentText, shortUrl,
    setNotificationRead, rememberHandled, handledErrorMessage, getMemory, setMemory,
    BIZ_ZONE_DEFAULT, getZone, setZone, zoneOffsetMs, startOfDayIn, dayKeyIn, daysApartIn,
    fetchTrelloMembers, cardMembers, knownPeople, mergePeople, matchPeople,
    getFollowup, setFollowup, nextWeekRange, calendarUrl, extractCalendarEvents,
    parseCalendarLabel, searchTrelloCards, fetchCardChecklists, bestCardForEvent,
    cardCode, clientTokensFrom, cleanNameText, dedupeEvents, CODE_RE, BRACKET_CODE_RE,
    nameTokens, draftLineFor, buildFollowupText, GOOGLE_ACCOUNTS,
    buildCardMessage, shouldSendByDefault, eventMatchesRequired, eventIsSkipped,
    WANTED_DOCS, wantedCategories, relevantAsks, docLabels,
    fetchCardComments, fetchCardBundle, myChases, chaseState, MY_USERNAMES, daysBetween,
    readCardHistory, askNote, shortDate, segments, stanceOf, DOC_TALK,
    chipForEvent, decodeDateKey, meetingDate, whenLabel, DAY_SHORT, MONTH_SHORT,
    UI_RANGES, GROUPS, groupFor, inGroup,
    AI_MODELS, AI_SYSTEM, getAI, setAI, buildContext, askClaude, aiErrorMessage,
    getDailyUpdate, setDailyUpdate, buildDailyUpdateContext, draftDailyUpdate,
    getPush, setPush, pushToPhone,
    BOARD_COLUMNS, fetchCards, createCard, fileCard, moveCard, updateCard, deleteCard,
    BUCKETS, GEMINI_MODELS, getTriage, setTriage, triageMentions, parseTriage, triageError,
    listGeminiModels, geminiModelLabel,
    LEDGER_STATES, LEDGER_PROMPT, ledgerLines, ledgerFromHistory, cardLedger,
    MEETING_SUBJECT, EMAIL_NOISE, emailNoise, lastMeetingFrom, emailsSinceMeeting,
    parseQuestion, answerCorpus, localAnswer,
    getRules, setRules, getSnapshots, markSeen, setItemsSeen, forgetPage, runScan, mentionsOnly, newId, ago,
    mentionSummary
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = QA;
