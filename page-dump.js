/* Hand over the page exactly as the extension sees it — any page, not just Canopy.

   Why this file exists: reading Canopy took five attempts because I was inventing
   selectors from screenshots. Once Rafay sent the real markup it took one. Gmail's
   DOM is worse than Canopy's, so before writing a line of Gmail reader, get the
   real page.

   Injected on demand as a FILE, which is the mechanism that proved reliable when
   injecting a serialised function did not. It reads and answers; it never clicks,
   changes, submits or uploads anything. */

(function () {
  if (window.__nudgePageDump) return;
  window.__nudgePageDump = true;

  function dump() {
    const bits = [];
    let shadows = 0;
    let frames = 0;

    const walk = function (root, depth) {
      if (!root || depth > 12) return;
      let kids;
      try { kids = root.querySelectorAll('*'); } catch (e) { return; }
      for (let i = 0; i < kids.length; i++) {
        const el = kids[i];
        if (el.shadowRoot) {
          shadows++;
          bits.push('<!-- ===== shadow root #' + shadows + ' inside ' +
            el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + ' ===== -->');
          try { bits.push(el.shadowRoot.innerHTML); } catch (e) { /* not ours to read */ }
          walk(el.shadowRoot, depth + 1);
        }
      }
    };
    walk(document, 0);

    /* Gmail in particular puts its whole interface inside iframes on some
       layouts. Same-origin ones can be read; cross-origin ones are noted so a
       missing chunk is explained rather than mysterious. */
    const iframes = document.querySelectorAll('iframe');
    for (let i = 0; i < iframes.length; i++) {
      let doc = null;
      try { doc = iframes[i].contentDocument; } catch (e) { doc = null; }
      const src = iframes[i].getAttribute('src') || '(no src)';
      if (doc && doc.documentElement) {
        frames++;
        bits.push('<!-- ===== iframe #' + frames + ' ' + src + ' ===== -->');
        bits.push(doc.documentElement.outerHTML);
        walk(doc, 0);
      } else {
        bits.push('<!-- ===== iframe ' + src + ' could not be read (different origin) ===== -->');
      }
    }

    const head = [
      '<!-- Nudge page dump -->',
      '<!-- url: ' + location.href + ' -->',
      '<!-- title: ' + document.title + ' -->',
      '<!-- when: ' + new Date().toISOString() + ' -->',
      '<!-- shadow roots: ' + shadows + '   readable iframes: ' + frames + ' -->'
    ];

    return head.concat([document.documentElement.outerHTML]).concat(bits).join('\n');
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
    if (!msg || msg.type !== 'pageDump') return false;
    try {
      respond({ ok: true, url: location.href, title: document.title, html: dump() });
    } catch (e) {
      respond({ ok: false, error: String((e && e.message) || e) });
    }
    return true;
  });
})();
