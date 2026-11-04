// Injected into every proxied HTML page. Talks to the Side by Side UI (the
// parent window) via postMessage: reports scroll, navigation and user
// interaction, and applies scroll/navigation commands from the other pane.
(function () {
  if (window.top === window || window.__sbsAgent) return;
  window.__sbsAgent = true;

  var parentWin = window.parent;
  function post(msg) {
    msg.__sbs = 1;
    try { parentWin.postMessage(msg, '*'); } catch (e) { /* ignore */ }
  }

  // --- scroll container -------------------------------------------------
  // Most sites scroll the window, but some scroll an inner wrapper. We track
  // whichever large element actually scrolls and identify it by a CSS path so
  // the other pane can find its equivalent.
  var scroller = null; // null = window

  function cssPath(el) {
    if (!el || el === document.documentElement || el === document.body) return null;
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.body) {
      if (el.id) { parts.unshift('#' + CSS.escape(el.id)); break; }
      var i = 1, sib = el;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === el.tagName) i++;
      parts.unshift(el.tagName.toLowerCase() + ':nth-of-type(' + i + ')');
      el = el.parentElement;
    }
    return parts.join(' > ');
  }

  function metrics() {
    if (scroller) {
      return {
        x: scroller.scrollLeft, y: scroller.scrollTop,
        maxX: Math.max(0, scroller.scrollWidth - scroller.clientWidth),
        maxY: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
        selector: cssPath(scroller),
      };
    }
    var el = document.scrollingElement || document.documentElement;
    return {
      x: window.scrollX, y: window.scrollY,
      maxX: Math.max(0, el.scrollWidth - window.innerWidth),
      maxY: Math.max(0, el.scrollHeight - window.innerHeight),
      selector: null,
    };
  }

  var ticking = false;
  document.addEventListener('scroll', function (e) {
    var t = e.target;
    if (t === document || t === document.documentElement || t === document.body) {
      scroller = null;
    } else if (t.clientHeight >= window.innerHeight * 0.6) {
      scroller = t; // a big inner scroller
    } else {
      return; // carousels, dropdowns, etc.
    }
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      ticking = false;
      var m = metrics();
      m.type = 'scroll';
      post(m);
    });
  }, { capture: true, passive: true });

  function scrollTo(msg) {
    var target = null;
    if (msg.selector) {
      try { target = document.querySelector(msg.selector); } catch (e) { target = null; }
    }
    var x, y;
    if (target) {
      var maxY = target.scrollHeight - target.clientHeight;
      var maxX = target.scrollWidth - target.clientWidth;
      y = msg.mode === 'pct' ? msg.ry * maxY : msg.y;
      x = msg.mode === 'pct' ? msg.rx * maxX : msg.x;
      target.scrollTo({ left: x, top: y, behavior: 'instant' });
    } else {
      var el = document.scrollingElement || document.documentElement;
      y = msg.mode === 'pct' ? msg.ry * (el.scrollHeight - window.innerHeight) : msg.y;
      x = msg.mode === 'pct' ? msg.rx * (el.scrollWidth - window.innerWidth) : msg.x;
      window.scrollTo({ left: x, top: y, behavior: 'instant' });
    }
  }

  // --- interaction: tells the UI which pane the user is driving ----------
  ['wheel', 'touchstart', 'keydown', 'mousedown', 'pointermove'].forEach(function (type) {
    var last = 0;
    window.addEventListener(type, function () {
      var now = Date.now();
      if (type === 'pointermove' && now - last < 250) return;
      last = now;
      post({ type: 'active' });
    }, { capture: true, passive: true });
  });

  // --- navigation --------------------------------------------------------
  function currentPath() { return location.pathname + location.search + location.hash; }
  var lastPath = null;
  function checkNav() {
    var p = currentPath();
    if (p === lastPath) return;
    lastPath = p;
    post({ type: 'nav', path: p, title: document.title });
  }
  setInterval(checkNav, 200);
  window.addEventListener('popstate', checkNav);
  window.addEventListener('hashchange', checkNav);

  function getRouter() {
    // Nuxt 3 / Vue 3
    var root = document.querySelector('#__nuxt') || document.querySelector('[data-v-app]');
    var app = root && root.__vue_app__;
    if (app && app.config.globalProperties.$router) return app.config.globalProperties.$router;
    // Nuxt 2 / Vue 2
    if (window.$nuxt && window.$nuxt.$router) return window.$nuxt.$router;
    return null;
  }

  function navigate(path) {
    if (path === currentPath()) return;
    var router = getRouter();
    if (router) {
      try {
        var r = router.push(path);
        if (r && r.catch) r.catch(function () { location.assign(path); });
        return;
      } catch (e) { /* fall through */ }
    }
    location.assign(path);
  }

  window.addEventListener('message', function (e) {
    if (e.source !== parentWin) return;
    var msg = e.data;
    if (!msg || msg.__sbs !== 1) return;
    if (msg.type === 'scrollTo') scrollTo(msg);
    else if (msg.type === 'navigate') navigate(msg.path);
    else if (msg.type === 'ping') {
      var m = metrics(); m.type = 'scroll'; post(m);
      lastPath = null; checkNav();
    }
  });

  post({ type: 'hello', path: currentPath() });
  checkNav();
})();
