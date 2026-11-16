// Injected into every proxied HTML page. Talks to the Side by Side UI (the
// parent window) via postMessage: reports scroll, navigation and user
// interaction, and applies scroll/navigation commands from the other pane.
(function () {
  if (window.top === window || window.__sbsAgent) return;
  window.__sbsAgent = true;

  // --- single-page-app mode ------------------------------------------------
  // Nuxt sites are told about the /x/<site> prefix through their baseURL. Other
  // apps (plain Vue/React builds) have their router base and file paths fixed
  // at build time, so for those the server marks this script with data-spa:
  // we hide the prefix from the app's address before it starts, and put the
  // prefix back on every request the app makes to its own site.
  var SPA = (document.currentScript && document.currentScript.getAttribute('data-spa')) || '';
  if (SPA) setupSpa(SPA);

  // --- emulated device ("Switch to device") -----------------------------------
  // The server marks the script with the device's profile. The page then sees
  // that device (user agent, touch, pixel density), and the mouse behaves like
  // a finger: press-and-drag sends touch events, drags scroll the page, and
  // swipes are mirrored to the other pane. A quick tap is still a normal click.
  var DEV = null;
  try { DEV = JSON.parse((document.currentScript && document.currentScript.getAttribute('data-device')) || 'null'); } catch (e) { DEV = null; }
  if (DEV) setupDevice(DEV);

  function setupDevice(D) {
    var apple = D.os === 'ios' || D.os === 'ipados';
    var def = function (obj, prop, get) {
      try { Object.defineProperty(obj, prop, { configurable: true, get: get }); } catch (e) { /* ignore */ }
    };
    def(navigator, 'userAgent', function () { return D.ua; });
    def(navigator, 'appVersion', function () { return D.ua.replace(/^Mozilla\//, ''); });
    def(navigator, 'platform', function () { return D.os === 'ios' ? 'iPhone' : D.os === 'ipados' ? 'MacIntel' : 'Linux armv81'; });
    def(navigator, 'vendor', function () { return apple ? 'Apple Computer, Inc.' : 'Google Inc.'; });
    def(navigator, 'maxTouchPoints', function () { return 5; });
    def(navigator, 'userAgentData', function () {
      if (apple) return undefined; // Safari doesn't have it
      return {
        mobile: !!D.mobile, platform: 'Android',
        brands: [{ brand: 'Chromium', version: '138' }, { brand: 'Google Chrome', version: '138' }],
        getHighEntropyValues: function () { return Promise.resolve({ mobile: !!D.mobile, platform: 'Android', model: '' }); },
      };
    });
    def(window, 'devicePixelRatio', function () { return D.dpr; });
    def(screen, 'width', function () { return window.innerWidth; });
    def(screen, 'availWidth', function () { return window.innerWidth; });
    if (!('ontouchstart' in window)) { try { window.ontouchstart = null; } catch (e) { /* ignore */ } }
    // JS media checks for touch screens (CSS @media rules can't be changed).
    var mm = window.matchMedia && window.matchMedia.bind(window);
    if (mm) {
      window.matchMedia = function (q) {
        return mm(String(q)
          .replace(/\(\s*(any-)?pointer\s*:\s*coarse\s*\)/gi, '(min-width: 0px)')
          .replace(/\(\s*(any-)?pointer\s*:\s*fine\s*\)/gi, '(max-width: 0px)')
          .replace(/\(\s*(any-)?hover\s*:\s*none\s*\)/gi, '(min-width: 0px)')
          .replace(/\(\s*(any-)?hover\s*:\s*hover\s*\)/gi, '(max-width: 0px)'));
      };
    }

    // Mouse -> touch
    var canTouch = typeof Touch === 'function' && typeof TouchEvent === 'function';
    function fireTouch(type, target, x, y, id, ended) {
      if (!canTouch) return { defaultPrevented: false };
      try {
        var t = new Touch({ identifier: id, target: target, clientX: x, clientY: y, pageX: x + window.scrollX, pageY: y + window.scrollY, screenX: x, screenY: y, radiusX: 11, radiusY: 11, force: 1 });
        var list = ended ? [] : [t];
        var ev = new TouchEvent(type, { bubbles: true, cancelable: true, composed: true, touches: list, targetTouches: list, changedTouches: [t] });
        target.dispatchEvent(ev);
        return ev;
      } catch (e) { return { defaultPrevented: false }; }
    }
    function scrollableParent(el) {
      for (var n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
        var st = getComputedStyle(n);
        if (/(auto|scroll)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 1) return n;
      }
      return null;
    }
    var drag = null, touchId = 1;
    var swallow = function (e) { if (e.isTrusted) e.stopImmediatePropagation(); };
    window.addEventListener('mousedown', function (e) {
      if (e.button !== 0 || !e.isTrusted) return;
      var t = e.target;
      // Typing and selecting in form fields stays mouse-driven.
      if (t.closest && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
      e.stopImmediatePropagation(); // a phone sends touches, not mouse presses
      drag = { id: touchId++, target: t, x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY, moved: false, claimed: false, horiz: false, t0: performance.now(), path: [], scroller: scrollableParent(t) };
      fireTouch('touchstart', t, e.clientX, e.clientY, drag.id);
    }, true);
    window.addEventListener('mousemove', function (e) {
      if (!drag) return;
      swallow(e);
      var dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
      if (!drag.moved) {
        if (Math.abs(dx) + Math.abs(dy) < 6) return;
        drag.moved = true;
        drag.horiz = Math.abs(dx) > Math.abs(dy);
        document.documentElement.style.userSelect = 'none';
      }
      if (fireTouch('touchmove', drag.target, e.clientX, e.clientY, drag.id).defaultPrevented) drag.claimed = true;
      if (!drag.claimed && !drag.horiz) {
        var by = drag.ly - e.clientY; // drag up -> page moves up
        if (drag.scroller) drag.scroller.scrollTop += by; else window.scrollBy(0, by);
      }
      drag.lx = e.clientX; drag.ly = e.clientY;
      drag.path.push([dx, dy, Math.round(performance.now() - drag.t0)]);
    }, true);
    window.addEventListener('mouseup', function (e) {
      if (!drag || e.button !== 0) return;
      var d = drag;
      drag = null;
      document.documentElement.style.userSelect = '';
      var end = fireTouch('touchend', d.target, e.clientX, e.clientY, d.id, true);
      if (!d.moved) {
        if (end.defaultPrevented) {
          // The page handled the tap by touch and cancelled the click, as on a
          // real phone: drop the click, but still mirror the tap.
          swallow(e);
          var cancel = function (ev) { ev.stopImmediatePropagation(); ev.preventDefault(); };
          window.addEventListener('click', cancel, true);
          setTimeout(function () { window.removeEventListener('click', cancel, true); }, 0);
          if (window.__sbsDescribeTap) window.__sbsDescribeTap(d.target);
          return;
        }
        // A tap: let the page see the press it missed, then the normal click follows.
        try {
          d.target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: d.x0, clientY: d.y0, button: 0, buttons: 1, view: window }));
        } catch (err) { /* ignore */ }
        return;
      }
      swallow(e);
      // A swipe isn't a click.
      var stopClick = function (ev) { ev.stopImmediatePropagation(); ev.preventDefault(); };
      window.addEventListener('click', stopClick, true);
      setTimeout(function () { window.removeEventListener('click', stopClick, true); }, 0);
      if (d.horiz || d.claimed) {
        var r = d.target.getBoundingClientRect();
        post({
          type: 'swipe',
          ref: { tag: d.target.tagName.toLowerCase(), text: norm(d.target).slice(0, 120), path: cssPath(d.target) },
          start: [(d.x0 - r.left) / Math.max(1, r.width), (d.y0 - r.top) / Math.max(1, r.height)],
          size: [r.width, r.height],
          path: d.path,
        });
      }
    }, true);
    document.addEventListener('dragstart', function (e) { if (drag) e.preventDefault(); }, true);

    // Replaying a tap from the other pane: the same sequence a phone sends.
    window.__sbsTap = function (el) {
      var r = el.getBoundingClientRect();
      var x = r.left + r.width / 2, y = r.top + r.height / 2, id = touchId++;
      fireTouch('touchstart', el, x, y, id);
      if (fireTouch('touchend', el, x, y, id, true).defaultPrevented) return; // handled by touch
      var opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, view: window };
      try {
        el.dispatchEvent(new MouseEvent('mousedown', Object.assign({ buttons: 1 }, opts)));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
      } catch (e) { /* ignore */ }
      el.click();
    };

    // Replaying a swipe from the other pane on the matching element.
    window.__sbsReplaySwipe = function (msg) {
      var el = null;
      if (msg.ref.text && msg.ref.text.length >= 2) {
        var m = Array.prototype.filter.call(document.getElementsByTagName(msg.ref.tag), function (x) { return norm(x).slice(0, 120) === msg.ref.text; });
        el = m[0] || null;
      }
      if (!el && msg.ref.path) { try { el = document.querySelector(msg.ref.path); } catch (e) { el = null; } }
      if (!el) { post({ type: 'clickMissed', text: 'the swiped element' }); return; }
      var r = el.getBoundingClientRect();
      var kx = r.width / Math.max(1, msg.size[0]), ky = r.height / Math.max(1, msg.size[1]);
      var x0 = r.left + msg.start[0] * r.width, y0 = r.top + msg.start[1] * r.height;
      var id = touchId++, i = 0, t0 = performance.now();
      var pointer = function (type, x, y) {
        try {
          el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 900 + id, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1 }));
        } catch (e) { /* ignore */ }
      };
      pointer('pointerdown', x0, y0);
      fireTouch('touchstart', el, x0, y0, id);
      var last = [x0, y0];
      (function step() {
        var now = performance.now() - t0;
        while (i < msg.path.length && msg.path[i][2] <= now) {
          last = [x0 + msg.path[i][0] * kx, y0 + msg.path[i][1] * ky];
          pointer('pointermove', last[0], last[1]);
          fireTouch('touchmove', el, last[0], last[1], id);
          i++;
        }
        if (i < msg.path.length) { requestAnimationFrame(step); return; }
        pointer('pointerup', last[0], last[1]);
        fireTouch('touchend', el, last[0], last[1], id, true);
      })();
    };
  }

  function setupSpa(P) {
    var KEY = P.slice(3).replace(/[^a-z0-9]/gi, '_');

    // 1. The app should see its real path, e.g. /eligibility.
    if (location.pathname.indexOf(P) === 0) {
      history.replaceState(history.state, '', (location.pathname.slice(P.length) || '/') + location.search + location.hash);
    }

    // 2. Requests to this origin get the prefix back.
    function fix(u) {
      if (u == null) return u;
      var str = String(u);
      if (!str || str.charAt(0) === '#' || /^(data|blob|javascript|mailto|tel|about):/i.test(str)) return u;
      var a;
      try { a = new URL(str, location.href); } catch (e) { return u; }
      if (a.origin !== location.origin) return u;
      if (a.pathname.indexOf('/x/') === 0 || a.pathname.indexOf('/__sbs/') === 0) return u;
      return P + a.pathname + a.search + a.hash;
    }
    var mine = function (u) { return typeof u === 'string' && u.indexOf(P + '/') === 0; };

    function patchProp(Ctor, prop) {
      if (!Ctor) return;
      var d = Object.getOwnPropertyDescriptor(Ctor.prototype, prop);
      if (!d || !d.set) return;
      Object.defineProperty(Ctor.prototype, prop, {
        configurable: true, enumerable: d.enumerable, get: d.get,
        set: function (v) { d.set.call(this, fix(v)); },
      });
    }
    [[window.HTMLScriptElement, 'src'], [window.HTMLLinkElement, 'href'], [window.HTMLImageElement, 'src'],
     [window.HTMLMediaElement, 'src'], [window.HTMLSourceElement, 'src'], [window.HTMLTrackElement, 'src'],
     [window.HTMLIFrameElement, 'src'], [window.HTMLEmbedElement, 'src'], [window.HTMLObjectElement, 'data']]
      .forEach(function (x) { patchProp(x[0], x[1]); });

    var setAttr = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      var n = String(name).toLowerCase();
      if ((n === 'src' && /^(SCRIPT|IMG|AUDIO|VIDEO|SOURCE|TRACK|IFRAME|EMBED)$/.test(this.tagName)) ||
          (n === 'href' && this.tagName === 'LINK')) value = fix(value);
      return setAttr.call(this, name, value);
    };

    var origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (input, init) {
        var url = typeof input === 'string' || input instanceof URL ? String(input) : input && input.url;
        var fixed = fix(url);
        if (!mine(fixed)) return origFetch.call(this, input, init);
        var headers = new Headers((init && init.headers) || (input && input.headers) || undefined);
        headers.set('x-sbs-spa', '1');
        if (input && typeof input === 'object' && !(input instanceof URL)) input = new Request(fixed, input);
        else input = fixed;
        return origFetch.call(this, input, Object.assign({}, init, { headers: headers }));
      };
    }
    var xhrOpen = XMLHttpRequest.prototype.open, xhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments);
      args[1] = fix(url);
      this.__sbsMine = mine(args[1]);
      return xhrOpen.apply(this, args);
    };
    XMLHttpRequest.prototype.send = function () {
      if (this.__sbsMine) { try { this.setRequestHeader('x-sbs-spa', '1'); } catch (e) { /* ignore */ } }
      return xhrSend.apply(this, arguments);
    };
    if (window.Audio) {
      var OrigAudio = window.Audio;
      var PatchedAudio = function (src) { return arguments.length ? new OrigAudio(fix(src)) : new OrigAudio(); };
      PatchedAudio.prototype = OrigAudio.prototype;
      window.Audio = PatchedAudio;
    }
    if (navigator.sendBeacon) {
      var beacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = function (url, data) { return beacon(fix(url), data); };
    }
    if (window.EventSource) {
      var OrigES = window.EventSource;
      var PatchedES = function (url, opts) { return new OrigES(fix(url), opts); };
      PatchedES.prototype = OrigES.prototype;
      window.EventSource = PatchedES;
    }
    // Full-page link clicks and form posts the app doesn't handle itself.
    window.addEventListener('click', function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target && e.target.closest && e.target.closest('a[href]');
      if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
      var f = fix(a.href);
      if (mine(f)) { e.preventDefault(); location.assign(f); }
    });
    window.addEventListener('submit', function (e) {
      if (e.defaultPrevented || !e.target || !e.target.action) return;
      var f = fix(e.target.action);
      if (mine(f)) e.target.action = f;
    });

    // 3. Cookies and storage are kept per site, so live and staging (often the
    //    same app) don't overwrite each other. The server renames this site's
    //    cookies to the same namespace.
    var NS = '__sbsc_' + KEY + '__';
    var cookieDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    if (cookieDesc && cookieDesc.get) {
      Object.defineProperty(document, 'cookie', {
        configurable: true,
        get: function () {
          return cookieDesc.get.call(document).split(/;\s*/)
            .filter(function (c) { return c.indexOf(NS) === 0; })
            .map(function (c) { return c.slice(NS.length); }).join('; ');
        },
        set: function (v) {
          var parts = String(v).split(';');
          var rest = parts.slice(1).filter(function (x) { return !/^\s*(path|domain)\s*=/i.test(x); });
          cookieDesc.set.call(document, [NS + parts[0].trim()].concat(rest, [' path=/']).join(';'));
        },
      });
    }
    var SP = window.Storage && Storage.prototype;
    if (SP) {
      var SNS = 'sbs:' + KEY + ':';
      var get = SP.getItem, set = SP.setItem, remove = SP.removeItem, key = SP.key;
      var lenDesc = Object.getOwnPropertyDescriptor(SP, 'length');
      var own = function (st) {
        var out = [], n = lenDesc.get.call(st);
        for (var i = 0; i < n; i++) { var k = key.call(st, i); if (k && k.indexOf(SNS) === 0) out.push(k); }
        return out;
      };
      SP.getItem = function (k) { return get.call(this, SNS + k); };
      SP.setItem = function (k, v) { return set.call(this, SNS + k, v); };
      SP.removeItem = function (k) { return remove.call(this, SNS + k); };
      SP.key = function (i) { var k = own(this)[i]; return k == null ? null : k.slice(SNS.length); };
      SP.clear = function () { var st = this; own(st).forEach(function (k) { remove.call(st, k); }); };
      Object.defineProperty(SP, 'length', { configurable: true, get: function () { return own(this).length; } });
    }
  }

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
    if (SPA) return SPA;
    var m = /^\/x\/[^/]+/.exec(location.pathname);
    return m ? m[0] : '';
  }
  function currentPath() {
    if (SPA) return location.pathname + location.search + location.hash; // already without the prefix
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
    // plain Vue 2 apps keep their instance on the mount element
    var els = [document.getElementById('app')].concat(Array.prototype.slice.call(document.body ? document.body.children : []));
    for (var i = 0; i < els.length; i++) {
      var vm = els[i] && els[i].__vue__;
      if (vm && vm.$router) return vm.$router;
      if (els[i] && els[i].__vue_app__ && els[i].__vue_app__.config.globalProperties.$router) return els[i].__vue_app__.config.globalProperties.$router;
    }
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

  // Checkbox/radio menu toggles (the "hidden checkbox + label" pattern) are
  // UI, not form input, as long as they aren't part of a form.
  function uiToggleInput(el) {
    var input = el.tagName === 'LABEL' ? el.control : el;
    return !!input && input.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(input.type) && !input.form;
  }

  function clickable(t, allowLinks) {
    if (!t || !t.closest) return null;
    var lab = t.closest('label');
    if (lab) return uiToggleInput(lab) ? lab : null;
    if (t.matches('input')) return uiToggleInput(t) ? t : null;
    var el = t.closest(TOGGLE);
    if (!el) {
      // Plain elements with a click handler usually show a pointer cursor.
      for (var n = t, i = 0; n && n !== document.body && i < 5; n = n.parentElement, i++) {
        if (getComputedStyle(n).cursor === 'pointer') { el = n; break; }
      }
    }
    var link = t.closest('a[href]');
    if (link && !/^(#|javascript:)/i.test(link.getAttribute('href'))) return allowLinks ? link : null;
    if (!el) return null;
    if (el.matches('select,textarea,option')) return null;
    if (el.tagName === 'BUTTON' && (el.type === 'submit' && el.form)) return null;
    return el;
  }

  function sameText(tag, text) {
    return Array.prototype.filter.call(document.getElementsByTagName(tag), function (e) { return norm(e) === text; });
  }

  // Attributes that identify icon-only controls (hamburgers, close buttons).
  var KEY_ATTRS = ['id', 'data-testid', 'aria-controls', 'aria-label', 'title', 'name', 'for'];
  function keyOf(el) {
    var k = {};
    KEY_ATTRS.forEach(function (a) { var v = el.getAttribute(a); if (v) k[a] = v; });
    return k;
  }
  function findByKey(tag, key) {
    for (var i = 0; key && i < KEY_ATTRS.length; i++) {
      var a = KEY_ATTRS[i];
      if (!key[a]) continue;
      var found = document.querySelector(tag + '[' + a + '="' + CSS.escape(key[a]) + '"]');
      if (found) return found;
    }
    return null;
  }

  function describe(el) {
    var text = norm(el);
    var tag = el.tagName.toLowerCase();
    var index = text.length >= 2 ? sameText(tag, text).indexOf(el) : -1;
    return { type: 'click', tag: tag, text: text, index: index, path: cssPath(el), key: keyOf(el) };
  }

  var labelControl = null; // a label click makes the browser click its checkbox too
  document.addEventListener('click', function (e) {
    if (!e.isTrusted) return; // ignore clicks we replayed ourselves
    var el = clickable(e.target, false);
    if (el && el === labelControl) { labelControl = null; return; }
    if (el && el.tagName === 'LABEL') {
      labelControl = el.control;
      setTimeout(function () { labelControl = null; }, 0);
    }
    if (el) { post(describe(el)); return; }
    // A link that opens a submenu instead of navigating: mirror it only if the
    // page cancelled the navigation and stayed on the same page.
    var link = clickable(e.target, true);
    if (!link) return;
    var before = location.href;
    setTimeout(function () {
      if (e.defaultPrevented && location.href === before) post(describe(link));
    }, 150);
  }, true);

  // Not form fields or links: safe to tap on the other side.
  function tappable(t) {
    if (!t || !t.closest || t.closest('a[href], form, input, select, textarea, option, label, [contenteditable]')) return null;
    return t;
  }

  // Used by device mode, where a tap the page handled by touch never clicks.
  // The page handling it is proof it's a control, even if it doesn't look like one.
  window.__sbsDescribeTap = function (t) {
    var el = clickable(t, false) || clickable(t, true) || tappable(t);
    if (!el) return;
    var msg = describe(el);
    msg.touch = true;
    post(msg);
  };

  function replayClick(msg) {
    var el = null;
    if (msg.text && msg.text.length >= 2 && msg.index >= 0) {
      var matches = sameText(msg.tag, msg.text);
      if (matches.length) el = matches[Math.min(msg.index, matches.length - 1)];
    }
    if (!el && msg.key) el = findByKey(msg.tag, msg.key);
    if (!el && msg.path) {
      try { el = document.querySelector(msg.path); } catch (e) { el = null; }
    }
    if (!el || !(clickable(el, true) || (msg.touch && tappable(el)))) { post({ type: 'clickMissed', text: msg.text }); return; }
    // On an emulated phone, tap like a finger would; otherwise click.
    if (window.__sbsTap) window.__sbsTap(el); else el.click();
  }

  window.addEventListener('message', function (e) {
    if (e.source !== parentWin) return;
    var msg = e.data;
    if (!msg || msg.__sbs !== 1) return;
    if (msg.type === 'scrollTo') scrollTo(msg);
    else if (msg.type === 'navigate') navigate(msg.path);
    else if (msg.type === 'click') replayClick(msg);
    else if (msg.type === 'swipe' && window.__sbsReplaySwipe) window.__sbsReplaySwipe(msg);
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
