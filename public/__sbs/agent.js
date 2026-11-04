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

  // Esc inside the page should still reach the app (e.g. to stop drawing).
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') post({ type: 'escape' });
  }, true);

  // --- navigation --------------------------------------------------------
  // Pages are served under /x/<site>/...; report paths without that prefix.
  function prefix() {
    var m = /^\/x\/[^/]+/.exec(location.pathname);
    return m ? m[0] : '';
  }
  function currentPath() {
    return (location.pathname.slice(prefix().length) || '/') + location.search + location.hash;
  }
  var lastPath = null;
  function checkNav() {
    var p = currentPath();
    if (p === lastPath) return;
    lastPath = p;
    post({ type: 'nav', path: p, site: prefix().slice(3), title: document.title });
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
    // Nuxt 3/4 routers use the rewritten baseURL, so they accept bare paths.
    if (router) {
      try {
        var r = router.push(path);
        if (r && r.catch) r.catch(function () { location.assign(prefix() + path); });
        return;
      } catch (e) { /* fall through */ }
    }
    location.assign(prefix() + path);
  }

  // --- click sync (accordions, tabs, toggles) ----------------------------
  // Only UI toggles are mirrored. Links are handled by navigation sync, and
  // form fields / submit buttons are never mirrored, so nothing gets
  // submitted on the other site by accident.
  var TOGGLE = 'summary,[aria-expanded],[aria-controls],[role=tab],[role=button],[role=switch],' +
    '[data-toggle],[data-bs-toggle],button';

  function norm(el) { return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160); }

  function clickable(t) {
    if (!t || !t.closest) return null;
    var el = t.closest(TOGGLE);
    if (!el) {
      // Plain elements with a click handler usually show a pointer cursor.
      for (var n = t, i = 0; n && n !== document.body && i < 5; n = n.parentElement, i++) {
        if (getComputedStyle(n).cursor === 'pointer') { el = n; break; }
      }
    }
    if (!el) return null;
    var link = el.closest('a[href]');
    if (link && !/^(#|javascript:)/i.test(link.getAttribute('href'))) return null;
    if (el.matches('input,select,textarea,option,label') || el.closest('label')) return null;
    if (el.tagName === 'BUTTON' && (el.type === 'submit' && el.form)) return null;
    return el;
  }

  function sameText(tag, text) {
    return Array.prototype.filter.call(document.getElementsByTagName(tag), function (e) { return norm(e) === text; });
  }

  document.addEventListener('click', function (e) {
    if (!e.isTrusted) return; // ignore clicks we replayed ourselves
    var el = clickable(e.target);
    if (!el) return;
    var text = norm(el);
    var tag = el.tagName.toLowerCase();
    var index = text.length >= 2 ? sameText(tag, text).indexOf(el) : -1;
    post({ type: 'click', tag: tag, text: text, index: index, path: cssPath(el) });
  }, true);

  function replayClick(msg) {
    var el = null;
    if (msg.text && msg.text.length >= 2 && msg.index >= 0) {
      var matches = sameText(msg.tag, msg.text);
      if (matches.length) el = matches[Math.min(msg.index, matches.length - 1)];
    }
    if (!el && msg.path) {
      try { el = document.querySelector(msg.path); } catch (e) { el = null; }
    }
    if (el && clickable(el)) el.click();
    else post({ type: 'clickMissed', text: msg.text });
  }

  window.addEventListener('message', function (e) {
    if (e.source !== parentWin) return;
    var msg = e.data;
    if (!msg || msg.__sbs !== 1) return;
    if (msg.type === 'scrollTo') scrollTo(msg);
    else if (msg.type === 'navigate') navigate(msg.path);
    else if (msg.type === 'click') replayClick(msg);
    else if (msg.type === 'scrollBy') {
      // Wheel scrolling forwarded from the app while an annotation tool is on.
      if (scroller && document.contains(scroller)) scroller.scrollBy(msg.dx, msg.dy);
      else window.scrollBy({ left: msg.dx, top: msg.dy, behavior: 'instant' });
    }
    else if (msg.type === 'ping') {
      var m = metrics(); m.type = 'scroll'; post(m);
      lastPath = null; checkNav();
    }
  });

  post({ type: 'hello', path: currentPath() });
  checkNav();
})();
