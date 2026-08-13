/* Canopy reader, as a declared content script.

   Why this exists: reading Canopy through chrome.scripting.executeScript came
   back empty in BOTH the isolated and the page's own world — no error, just
   nothing. Rather than keep guessing at that, this uses a different mechanism
   altogether: Chrome injects this file itself on canopytax.com / getcanopy.com,
   it holds a reference to the live document from the start, and it answers when
   the panel asks. Nothing to inject, nothing to be blocked.

   It is read-only. It never clicks, changes or uploads anything. */

(function () {
  if (window.__nudgeCanopy) return;          // only once per page
  window.__nudgeCanopy = true;

  const clean = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();

  function readPage() {
    const out = {
      ok: true, via: 'content script', url: location.href, title: document.title,
      clientId: '', section: '', client: '', clientType: '', folder: '', filesVia: '',
      crumbs: [], files: [], inbox: [], folders: [], headings: [], trouble: []
    };
    const safe = (what, fn) => {
      try { fn(); } catch (e) { out.trouble.push(what + ': ' + ((e && e.message) || e)); }
    };

    /* ---------- shared helpers ---------- */
    /* No \b here, deliberately. An element's textContent runs its cells together
       with no space — "QB Financials12/29/2025" — and there is no word boundary
       between "s" and "1", so \b made every row look dateless. The File Inbox
       parser never had a \b, which is exactly why it was the part that worked. */
    const DATE = /\d{1,2}\/\d{1,2}\/\d{2,4}/;
    const isLeaf = function (el) { return !el.children || el.children.length === 0; };

    /* ---------- looking through shadow roots ----------
       Canopy is a single-spa application: several separate front-ends rendered
       into one page. Anything mounted inside a shadow root is invisible to
       document.querySelectorAll, which would explain a File Inbox that reads
       perfectly next to a file list that reads as empty. So every scan below
       runs over this instead: the whole page, shadow DOM included. */
    let SHADOWS = 0;
    const everyEl = function () {
      const acc = [];
      const walk = function (root, depth) {
        if (!root || depth > 12 || acc.length > 20000) return;
        let kids;
        try { kids = root.querySelectorAll('*'); } catch (e) { return; }
        for (let i = 0; i < kids.length; i++) {
          const el = kids[i];
          acc.push(el);
          if (el.shadowRoot) { SHADOWS++; walk(el.shadowRoot, depth + 1); }
        }
      };
      walk(document, 0);
      return acc;
    };
    const ALL = everyEl();
    const deep = function (sel) {
      const hit = [];
      for (let i = 0; i < ALL.length; i++) {
        try { if (ALL[i].matches && ALL[i].matches(sel)) hit.push(ALL[i]); } catch (e) { return hit; }
      }
      return hit;
    };
    /* the visible text of an element, cell by cell, in the order you read it */
    const leafTexts = function (el) {
      const outv = [];
      el.querySelectorAll('*').forEach(function (c) {
        if (!isLeaf(c)) return;
        const t = clean(c.textContent);
        if (t) outv.push(t);
      });
      return outv;
    };

    safe('url', function () {
      const idm = location.href.match(/\/(?:client|contact)s?\/(\d{3,})/i);
      out.clientId = idm ? idm[1] : '';
      const sec = location.href.match(/\/(?:client|contact)s?\/\d+\/([a-z\-]+)/i);
      out.section = sec ? sec[1].toLowerCase() : '';
    });

    /* The client's name heads the page. Worked out first, because the breadcrumb
       is recognised by starting with it. */
    safe('name seed', function () {
      /* Canopy puts the client's name in .cp-subheader and "Business" or
         "Individual" in the caption beneath it. Verified on the real page; the
         generic heading hunt below is the fallback for other sections. */
      const sub = deep('.cp-subheader')[0];
      const t = sub ? clean(sub.textContent)
        : (function () {
          const h = deep('h1, h2, [class*="page-title" i], [class*="client-name" i]')[0];
          return h ? clean(h.textContent) : '';
        })();
      if (t && t.length < 80) out.headingsSeed = t;
      const cap = deep('.cp-caption')
        .map(function (e) { return clean(e.textContent); })
        .filter(function (x) { return /^(business|individual)$/i.test(x); })[0];
      if (cap) out.clientType = cap;
    });

    /* the File Inbox — unfiled uploads, invisible unless you go looking */
    safe('inbox', function () {
      /* route 0: Canopy's own markup. Each unfiled document sits in a
         .inbox-file-name node, and its name, date and sender are the three leaf
         texts of the .cp-flex-column that holds it. Confirmed on the real page:
         the generic scan below found the names but lost the date and the sender. */
      const native = deep('.inbox-file-name');
      if (native.length) {
        native.forEach(function (el) {
          let box = el;
          for (let i = 0; i < 4 && box.parentElement; i++) {
            box = box.parentElement;
            if (/cp-flex-column/.test(box.className || '')) break;
          }
          const cells = leafTexts(box);
          const name = cells.filter(function (t) { return /\.[a-z0-9]{2,5}$/i.test(t); })[0] || cells[0] || '';
          if (!name) return;
          const date = (cells.filter(function (t) { return DATE.test(t); })[0] || '').match(DATE);
          const who = cells.filter(function (t) {
            return t !== name && !DATE.test(t) && t.length < 60;
          })[0] || '';
          out.inbox.push({ name: name, date: date ? date[0] : '', who: who });
        });
        if (out.inbox.length) {
          out.inboxVia = 'Canopy inbox rows';
          /* the panel still needs to know not to read these as folder contents */
          const card = native[0].closest ? native[0].closest('[class*="cp-card"]') : null;
          if (card) out.__inboxBox = card;
          return;
        }
      }

      let box = null;
      const all = deep('h1, h2, h3, h4, div, span, p');
      for (let i = 0; i < all.length; i++) {
        const t = clean(all[i].textContent);
        if (/^file inbox\b/i.test(t) && t.length < 80) {
          box = all[i].parentElement;
          while (box && box.querySelectorAll('*').length < 6 && box.parentElement) box = box.parentElement;
          break;
        }
      }
      if (!box) return;
      out.__inboxBox = box;      // stripped before this leaves the page
      const seen = {};
      box.querySelectorAll('*').forEach(function (el) {
        if (out.inbox.length > 40) return;
        if (el.children && el.children.length) return;
        const name = clean(el.textContent);
        if (name.length < 4 || name.length > 140) return;
        if (!/\.[a-z0-9]{2,5}$/i.test(name)) return;
        if (seen[name.toLowerCase()]) return;
        seen[name.toLowerCase()] = 1;
        const rowText = clean(el.parentElement ? el.parentElement.textContent : name);
        const dm = rowText.match(/\d{1,2}\/\d{1,2}\/\d{2,4}/);
        const who = clean(rowText.split(name).join(' ').split(dm ? dm[0] : ' ').join(' '));
        out.inbox.push({ name: name, date: dm ? dm[0] : '', who: who.slice(0, 60) });
      });
    });

    /* ---------- the file list ----------
       It was looked up by <th> column headings. On the real page there are no
       table headings to find, so it read as "no files in this folder" while ten
       files sat there. The File Inbox parser had no such trouble, because it
       looks for a DATE and works outwards from it — every row in a Canopy file
       list has one, and nothing in the folder tree or the breadcrumb does. Same
       trick here, with the heading route kept for pages that do have headings. */
    safe('files', function () {
      const seen = [];
      const push = function (f) {
        if (!f.name || f.name.length > 200) return;
        for (let i = 0; i < seen.length; i++) if (seen[i] === f.name.toLowerCase()) return;
        seen.push(f.name.toLowerCase());
        out.files.push(f);
      };

      /* route 0: Canopy's own markup.
         Confirmed against a saved copy of the real Files page rather than
         guessed at. Every row and the header share a "fileGrid" class and the
         same eight columns, so the header's labels give the column order and the
         row's own children line up with it — which keeps a folder with a blank
         "Added by" from shifting every later column along by one. */
      const grid = deep('[class*="fileGrid" i]').filter(function (g) {
        if (/fileListRow/i.test(g.className || '')) return false;
        const t = clean(g.textContent).toLowerCase();
        return t.indexOf('name') !== -1 && t.indexOf('date added') !== -1;
      })[0];
      const cols = [];
      if (grid) {
        for (let i = 0; i < grid.children.length; i++) {
          cols.push(clean(grid.children[i].textContent).toLowerCase());
        }
      }
      const nativeRows = deep('[class*="fileListRow" i]');
      if (nativeRows.length) {
        nativeRows.forEach(function (r) {
          const kids = r.children;
          const at = function (label, fallback) {
            let i = cols.indexOf(label);
            if (i < 0) i = fallback;
            return (i >= 0 && kids[i]) ? clean(kids[i].textContent) : '';
          };
          const name = at('name', 1);
          if (!name) return;
          push({
            name: name,
            added: at('date added', 2),
            addedBy: at('added by', 3),
            modified: at('last modified', 4),
            modifiedBy: at('last modified by', 5),
            isFile: /\.[a-z0-9]{2,5}$/i.test(name)
          });
        });
        if (out.files.length) {
          out.filesVia = 'Canopy file grid' + (cols.length ? ' (columns from the header)' : '');
          return;
        }
      }

      /* route 1: proper column headings, when the page gives us them */
      const wanted = ['name', 'date added', 'added by', 'last modified', 'last modified by', 'visible'];
      const tables = deep('table, [role="table"], [role="grid"]');
      for (let t = 0; t < tables.length; t++) {
        const table = tables[t];
        const heads = [];
        table.querySelectorAll('th, [role="columnheader"]').forEach(function (h) {
          heads.push(clean(h.textContent).toLowerCase());
        });
        if (heads.indexOf('name') === -1) continue;
        if (!heads.some(function (h) { return h === 'date added' || h === 'added by'; })) continue;

        const col = {};
        wanted.forEach(function (wname) { col[wname] = heads.indexOf(wname); });

        table.querySelectorAll('tbody tr, [role="row"]').forEach(function (r) {
          if (r.querySelector('th, [role="columnheader"]')) return;
          const cells = [];
          r.querySelectorAll('td, [role="gridcell"], [role="cell"]').forEach(function (c) {
            cells.push(clean(c.textContent));
          });
          if (!cells.length) return;
          const pick = function (key, fallback) {
            const i = col[key];
            return (i > -1 && cells[i] != null) ? cells[i] : (cells[fallback] || '');
          };
          push({
            name: pick('name', 0),
            added: pick('date added', 1),
            addedBy: pick('added by', 2),
            modified: pick('last modified', 3),
            modifiedBy: pick('last modified by', 4),
            isFile: /\.[a-z0-9]{2,5}$/i.test(pick('name', 0))
          });
        });
        if (out.files.length) break;
      }
      if (out.files.length) { out.filesVia = 'column headings'; return; }

      /* route 2: any row that carries a date. This is what the inbox does.

         The first attempt at this rejected a candidate if one of its CHILDREN
         also held a date, meaning to keep the innermost row. That assumed the
         cells were direct children. Nest them one level deeper and every
         candidate in the chain disqualifies itself, which is how a folder of
         ten files read as empty. So: collect every plausible row, then keep only
         those that contain no other candidate. Depth stops mattering. */
      const inboxBox = out.__inboxBox || null;
      const cand = [];
      const all = deep('div, tr, li, [role="row"], [role="listitem"]');
      for (let i = 0; i < all.length && cand.length < 600; i++) {
        const el = all[i];
        const txt = clean(el.textContent);
        if (!txt || txt.length > 400) continue;
        if (!DATE.test(txt)) continue;
        if (inboxBox && inboxBox.contains(el)) continue;      // that is the inbox, not this folder
        const cells = leafTexts(el);
        if (cells.length < 2 || cells.length > 20) continue;
        cand.push({ el: el, cells: cells });
      }
      /* keep the innermost: drop anything that contains another candidate */
      const rows = cand.filter(function (a) {
        for (let i = 0; i < cand.length; i++) {
          if (cand[i].el !== a.el && a.el.contains(cand[i].el)) return false;
        }
        return true;
      });

      /* If this still finds nothing, the next screenshot should tell me why
         rather than posing the question again. */
      out.shape = cand.slice(0, 4).map(function (r) {
        return (r.el.tagName || '?').toLowerCase() +
          (r.el.className && typeof r.el.className === 'string'
            ? '.' + r.el.className.split(/\s+/).slice(0, 2).join('.') : '') +
          ' [' + r.cells.length + ' cells] ' + r.cells.slice(0, 4).join(' | ').slice(0, 90);
      });
      out.shape.unshift('elements seen: ' + ALL.length + ' (shadow roots: ' + SHADOWS +
        '), date-bearing candidates: ' + cand.length + ', innermost: ' + rows.length);

      rows.forEach(function (r) {
        const cells = r.cells;
        /* the name is the first cell that is not a date, a count, or a control */
        let name = '';
        for (let i = 0; i < cells.length; i++) {
          const c = cells[i];
          if (DATE.test(c)) continue;
          if (/^[\d\s.,%$]+$/.test(c)) continue;
          if (c.length < 2 || c.length > 200) continue;
          name = c; break;
        }
        if (!name) return;
        const dates = cells.filter(function (c) { return DATE.test(c); })
          .map(function (c) { return (c.match(DATE) || [''])[0]; });
        /* whoever is named, in order, minus the name itself */
        const people = cells.filter(function (c) {
          return c !== name && !DATE.test(c) && /^[A-Z][A-Za-z.'\- ]{2,40}$/.test(c) &&
            !/\.[a-z0-9]{2,5}$/i.test(c);
        });
        push({
          name: name,
          added: dates[0] || '',
          addedBy: people[0] || '',
          modified: dates[1] || '',
          modifiedBy: people[1] || '',
          isFile: /\.[a-z0-9]{2,5}$/i.test(name)
        });
      });
      if (out.files.length) out.filesVia = 'rows with a date';
    });

    /* ---------- where you are ----------
       The breadcrumb was looked up by class name and was not found, so the panel
       fell back to showing the raw URL section. The folder tree is a better
       source anyway: the root item IS the client, and the highlighted item is
       the folder being looked at. */
    /* Canopy's own furniture. A run of these is the app's navigation, never a
       path through a client's documents, and never a client's name. */
    const CHROME_WORDS = ('inbox,clients,files,work,time,billing,templates,home,communication,' +
      'notes,tasks,engagements,resolution,organizers,contacts,transcripts,search,settings,' +
      'help,notifications,archived files,select all,add,name,date added,added by,visible,' +
      'last modified,last modified by,client info').split(',');
    const isChrome = function (t) {
      const s = String(t || '').toLowerCase().replace(/\s*\d+$/, '').trim();
      if (!s) return true;
      if (CHROME_WORDS.indexOf(s) !== -1) return true;
      if (/^\(.*\)$/.test(s)) return true;              // "(infrastructure squad)"
      if (/^[a-z-]+-(navbar|nav|bar|menu|rail)$/.test(s)) return true;  // "primary-navbar"
      if (/^\d+$/.test(s)) return true;
      return false;
    };

    /* the folder you are actually in, from the highlighted tree item.
       Worked out BEFORE the breadcrumb, because it is what confirms one. */
    safe('folder', function () {
      /* Canopy marks the open folder with .selected on a docs-subfolder-* node */
      const sel = deep('[id^="docs-subfolder-"].selected')[0] ||
        deep('[role="treeitem"][aria-selected="true"], [class*="tree" i] [aria-current="true"], ' +
        '[aria-selected="true"], [class*="tree" i] [class*="selected" i], ' +
        '[class*="tree" i] [class*="active" i]')[0];
      if (sel) {
        const t = clean(sel.textContent).replace(/\s*\d{1,4}$/, '');
        if (t && t.length < 70 && !isChrome(t)) out.folder = t;
      }
    });

    safe('crumbs', function () {
      /* A real breadcrumb ends at the folder you are in, and none of its steps
         are Canopy's own menu items. Shape alone matched the left navigation
         rail — "Clients / Files / Work / Time / Billing" — and the panel then
         reported that as the folder path. Shape is now only a candidate; this
         is what makes it a breadcrumb. */
      const looksLikeAPath = function (parts) {
        if (parts.length < 2 || parts.length > 8) return false;
        if (parts.some(function (t) { return isChrome(t) || t.length > 60 || DATE.test(t); })) return false;
        if (parts.join(' ').length > 160) return false;
        /* it must agree with something we already know */
        if (out.folder && parts[parts.length - 1] === out.folder) return true;
        if (out.headingsSeed && parts[0] === out.headingsSeed) return true;
        return false;
      };

      /* Canopy's breadcrumb is a row of tertiary buttons, with the chevrons drawn
         as icons rather than written as text. Nothing in the class names says
         "breadcrumb", which is why looking for that found the navigation rail. */
      const tert = deep('a.cp-button--tertiary, button.cp-button--tertiary')
        .map(function (a) { return clean(a.textContent); })
        .filter(function (t) { return t && t.length < 70 && !isChrome(t); });
      if (tert.length >= 2) {
        const uniq = [];
        tert.forEach(function (t) { if (uniq.indexOf(t) === -1) uniq.push(t); });
        if (looksLikeAPath(uniq)) { out.crumbs = uniq; out.crumbsVia = 'Canopy breadcrumb buttons'; return; }
      }

      const named = deep('[class*="breadcrumb" i], nav[aria-label*="readcrumb" i], ol[class*="crumb" i]')[0];
      if (named) {
        const parts = [];
        named.querySelectorAll('a, span, li, button, div').forEach(function (c) {
          if (!isLeaf(c)) return;
          const t = clean(c.textContent);
          if (t && t.length < 70 && t !== '>' && t !== '/' && parts.indexOf(t) === -1) parts.push(t);
        });
        if (looksLikeAPath(parts)) { out.crumbs = parts; out.crumbsVia = 'named breadcrumb'; return; }
      }

      const boxes = deep('div, nav, ol, ul');
      for (let i = 0; i < boxes.length; i++) {
        const kids = [];
        for (let j = 0; j < boxes[i].children.length; j++) {
          const t = clean(boxes[i].children[j].textContent);
          if (t && t !== '>' && t !== '/') kids.push(t);
        }
        if (looksLikeAPath(kids)) { out.crumbs = kids; out.crumbsVia = 'a row that ends where you are'; return; }
      }

      /* nothing trustworthy: say so rather than showing the navigation menu */
      out.crumbs = [];
    });

    /* the folder tree and its counts */
    safe('folders', function () {
      const seen = {};
      /* Canopy's tree: docs-subfolder-<id> is a folder, docs-subfolder-row-<id>
         is its wrapper and carries every child's text as well. Take the former. */
      const native = deep('[id^="docs-subfolder-"]').filter(function (el) {
        return !/^docs-subfolder-row-/.test(el.id || '');
      });
      (native.length ? native : deep('[role="treeitem"], [class*="tree" i] li, [class*="folder" i]'))
        .forEach(function (el) {
          if (out.folders.length > 60) return;
          if (el.querySelector('[role="treeitem"]')) return;
          /* Canopy writes the count straight onto the end of the name with no
             separator: "Client Uploaded Documents38". A lazy match with an
             optional trailing number simply swallowed the digits into the name,
             so every count came back empty. Try WITH a count first. */
          const raw = clean(el.textContent);
          if (!raw || raw.length > 70) return;
          let nm = raw;
          let count = null;
          const withCount = raw.match(/^(.*?[^\d\s])\s*(\d{1,4})$/);
          if (withCount && withCount[1].replace(/\s+/g, '').length >= 2) {
            nm = clean(withCount[1]);
            count = parseInt(withCount[2], 10);
          }
          if (!nm || nm.length < 2 || seen[nm.toLowerCase()]) return;
          seen[nm.toLowerCase()] = 1;
          out.folders.push({ name: nm, count: count });
        });
    });

    /* ---------- who this is ----------
       It showed "Client 13519635" while the name sat at the top of the page in
       large type, because it only ever looked at the breadcrumb. Four sources
       now, in order of how much they can be trusted. */
    safe('client', function () {
      deep('h1, h2, [class*="page-title" i], [class*="client-name" i]')
        .forEach(function (el) {
          const t = clean(el.textContent);
          if (t && t.length < 80 && out.headings.indexOf(t) === -1) out.headings.push(t);
        });
      /* It once reported the client as "Inbox", because that was simply the first
         thing on the page. Canopy's own menu words are never a client's name. */
      const take = function (t) {
        const s = clean(t);
        if (!s || s.length > 80 || isChrome(s)) return false;
        if (s === out.folder) return false;             // that is where you are, not who
        out.client = s;
        return true;
      };
      take(out.crumbs.length ? out.crumbs[0] : '') ||
        take(out.headingsSeed) ||
        (function () {
          for (let i = 0; i < out.headings.length; i++) if (take(out.headings[i])) return true;
          return false;
        })() ||
        /* the root of the folder tree is the client's own folder, and so their name */
        take(out.folders.length ? out.folders[0].name : '');

      const bits = deep('div, span, p, small, h3, h4');
      for (let i = 0; i < bits.length && i < 400; i++) {
        if (bits[i].children && bits[i].children.length) continue;
        const t = clean(bits[i].textContent);
        if (/^(business|individual)$/i.test(t)) { out.clientType = t; break; }
      }
    });

    /* a live element cannot cross the message boundary — drop it */
    delete out.__inboxBox;
    delete out.headingsSeed;
    return out;
  }

  /* ---------- hand over the page as the reader sees it ----------
     Copying outerHTML by hand from DevTools attached itself to the wrong Canopy
     tab and produced the login screen. This runs inside the tab the reader just
     read, so it cannot be aimed at the wrong one, and unlike outerHTML it
     descends into shadow roots — which is where a single-spa app may be keeping
     the very markup that needs explaining. */
  function pageDump() {
    const bits = [];
    bits.push('<!-- Nudge page dump -->');
    bits.push('<!-- url: ' + location.href + ' -->');
    bits.push('<!-- when: ' + new Date().toISOString() + ' -->');
    let shadows = 0;
    const walk = function (root, depth) {
      if (!root || depth > 12) return;
      let kids;
      try { kids = root.querySelectorAll('*'); } catch (e) { return; }
      for (let i = 0; i < kids.length; i++) {
        if (kids[i].shadowRoot) {
          shadows++;
          bits.push('<!-- ===== shadow root #' + shadows + ' inside ' +
            kids[i].tagName.toLowerCase() +
            (kids[i].id ? '#' + kids[i].id : '') + ' ===== -->');
          bits.push(kids[i].shadowRoot.innerHTML);
          walk(kids[i].shadowRoot, depth + 1);
        }
      }
    };
    walk(document, 0);
    const head = '<!-- shadow roots found: ' + shadows + ' -->';
    return [bits[0], bits[1], bits[2], head,
      document.documentElement.outerHTML].concat(bits.slice(3)).join('\n');
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
    if (!msg) return false;
    if (msg.type === 'canopyRead') {
      try {
        respond(readPage());
      } catch (e) {
        respond({ ok: false, via: 'content script', error: String((e && e.message) || e) });
      }
      return true;
    }
    if (msg.type === 'canopyDump') {
      try {
        respond({ ok: true, url: location.href, html: pageDump() });
      } catch (e) {
        respond({ ok: false, error: String((e && e.message) || e) });
      }
      return true;
    }
    return false;
  });
})();
