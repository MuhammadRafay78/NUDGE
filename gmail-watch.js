/* Gmail reader, as a declared content script — same mechanism as
   canopy-watch.js, for the same reason: Chrome injects this file itself on
   mail.google.com, it holds a reference to the live document from the
   start, and it answers when asked. Nothing to inject, nothing to be
   blocked.

   Gmail's own class names (gD, a3s, zA, …) are private and have shifted
   before, so this never leans on them alone: every structured field is
   read inside its own try/catch, and the raw visible text of the main
   pane is always captured too, as a fallback the AI can still answer from
   even if every selector below is stale by the time you read this.

   It is read-only. It never clicks, changes or sends anything. */

(function () {
  if (window.__nudgeGmail) return;          // only once per page
  window.__nudgeGmail = true;

  const clean = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();

  function readPage() {
    const out = {
      ok: true, via: 'content script', url: location.href, title: document.title,
      threadOpen: false, subject: '', participants: [], messages: [], inboxRows: [],
      pageText: '', trouble: []
    };
    const safe = (what, fn) => {
      try { fn(); } catch (e) { out.trouble.push(what + ': ' + ((e && e.message) || e)); }
    };

    const main = document.querySelector('div[role="main"]');
    if (!main) {
      out.ok = false;
      out.error = 'Gmail has not finished loading in this tab yet.';
      return out;
    }

    /* ---- is a single thread open, or is this a list (inbox/search)? ---- */
    safe('thread detection', function () {
      out.threadOpen = !!main.querySelector('h2.hP, div.adn.ads, div.if');
    });

    /* ---- subject ---- */
    safe('subject', function () {
      const h2 = main.querySelector('h2.hP') || main.querySelector('[role="heading"]');
      if (h2) out.subject = clean(h2.textContent);
      if (!out.subject) {
        // Gmail's tab title is usually "Subject - name@example.com - Gmail"
        const t = clean(document.title).replace(/\s*-\s*Gmail\s*$/i, '');
        out.subject = t.replace(/\s*-\s*\S+@\S+$/, '');
      }
    });

    /* ---- messages inside an open thread ---- */
    safe('messages', function () {
      const blocks = main.querySelectorAll('div.adn.ads, div.gs');
      const seen = {};
      blocks.forEach(function (b) {
        if (out.messages.length > 25) return;
        const senderEl = b.querySelector('span[email], .gD');
        const from = senderEl ? clean(senderEl.getAttribute('name') || senderEl.textContent) : '';
        const fromEmail = senderEl ? (senderEl.getAttribute('email') || '') : '';
        const dateEl = b.querySelector('span.g3, [title][id]');
        const when = dateEl ? clean(dateEl.getAttribute('title') || dateEl.textContent) : '';
        const bodyEl = b.querySelector('div.a3s');
        const body = bodyEl ? clean(bodyEl.innerText || bodyEl.textContent) : '';
        if (!from && !body) return;
        const key = (from + '|' + when + '|' + body).slice(0, 140);
        if (seen[key]) return;
        seen[key] = 1;
        if (fromEmail && out.participants.indexOf(fromEmail) === -1) out.participants.push(fromEmail);
        else if (from && out.participants.indexOf(from) === -1) out.participants.push(from);
        out.messages.push({ from: from, email: fromEmail, when: when, body: body.slice(0, 4000) });
      });
    });

    /* ---- visible rows when looking at a list (inbox / search / label) ---- */
    safe('list rows', function () {
      const rows = main.querySelectorAll('tr.zA');
      rows.forEach(function (r) {
        if (out.inboxRows.length > 60) return;
        const senderEl = r.querySelector('span[email]');
        const subjEl = r.querySelector('.y6 span[id], .bog');
        const snipEl = r.querySelector('.y2');
        const dateEl = r.querySelector('.xW span[title], td.xW');
        const from = senderEl ? clean(senderEl.getAttribute('name') || senderEl.textContent) : '';
        const subject = subjEl ? clean(subjEl.textContent) : '';
        if (!from && !subject) return;
        out.inboxRows.push({
          from: from,
          subject: subject,
          snippet: snipEl ? clean(snipEl.textContent) : '',
          date: dateEl ? clean(dateEl.getAttribute('title') || dateEl.textContent) : '',
          unread: (r.className || '').indexOf('zE') > -1
        });
      });
    });

    /* ---- always keep the raw visible text too — the safety net if Gmail's
       private classes above have moved on since this was written ---- */
    safe('visible text fallback', function () {
      out.pageText = clean(main.innerText || main.textContent || '').slice(0, 8000);
    });

    return out;
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
    if (!msg || msg.type !== 'gmailRead') return false;
    try {
      respond(readPage());
    } catch (e) {
      respond({ ok: false, error: String((e && e.message) || e) });
    }
    return true;
  });
})();
