/* Runs on trello.com. Watches Trello's own notification bell and tells the
   background the moment it changes, so a tag reaches you in a second or two
   instead of waiting for the next poll. Reads nothing, sends no page content —
   only a "something changed, go look" nudge. */

(function () {
  var BELL = '[data-testid*="notification" i], [aria-label*="notification" i], [class*="notification"], [class*="Notification"]';
  var last = '';
  var timer = null;
  var lastSignal = 0;

  function signature() {
    var s = '';
    try {
      var nodes = document.querySelectorAll(BELL);
      for (var i = 0; i < nodes.length && i < 40; i++) {
        s += (nodes[i].getAttribute('aria-label') || '') + '|' +
          (nodes[i].getAttribute('data-count') || '') + '|' +
          (nodes[i].textContent || '').slice(0, 24) + '~';
      }
    } catch (e) {}
    return s.slice(0, 800);
  }

  function nudge(why) {
    var now = Date.now();
    if (now - lastSignal < 3000) return;   // don't spam the worker
    lastSignal = now;
    try {
      const p = chrome.runtime.sendMessage({ type: 'trelloMaybeNew', why: why });
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (e) {}
  }

  function check(why) {
    var sig = signature();
    if (sig !== last) {
      last = sig;
      nudge(why);
    }
  }

  last = signature();

  var obs = new MutationObserver(function () {
    clearTimeout(timer);
    timer = setTimeout(function () { check('bell changed'); }, 700);
  });
  try {
    obs.observe(document.body || document.documentElement, {
      childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ['aria-label', 'data-count', 'title']
    });
  } catch (e) {}

  // belt and braces: a quiet heartbeat, and a look whenever you come back to the tab
  setInterval(function () { nudge('heartbeat'); }, 20000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) nudge('tab focused');
  });
  window.addEventListener('focus', function () { nudge('window focused'); });
  nudge('loaded');
})();
