(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var ROLES = ['live', 'staging'];

  var els = {
    form: $('form'), liveUrl: $('liveUrl'), stagingUrl: $('stagingUrl'), path: $('path'),
    syncScroll: $('syncScroll'), scrollMode: $('scrollMode'), syncNav: $('syncNav'),
    align: $('align'), viewport: $('viewport'), layout: $('layout'),
    overlayControls: $('overlayControls'), opacity: $('opacity'), difference: $('difference'),
    share: $('share'), stage: $('stage'), empty: $('empty'), toast: $('toast'),
  };

  var panes = {};
  ROLES.forEach(function (role) {
    var el = document.querySelector('.pane[data-role="' + role + '"]');
    panes[role] = {
      role: role,
      el: el,
      host: el.querySelector('.viewport-host'),
      viewport: el.querySelector('.viewport'),
      iframe: el.querySelector('iframe'),
      urlLabel: el.querySelector('[data-url]'),
      openLink: el.querySelector('[data-open]'),
      reload: el.querySelector('[data-reload]'),
      origin: null, // target site origin, e.g. https://www.example.com
      path: '/',
    };
  });
  var other = function (role) { return role === 'live' ? 'staging' : 'live'; };

  var leader = null;       // role the user is currently driving
  var pendingAlign = false;

  // --- storage (best effort) --------------------------------------------
  var store = {
    get: function (k) { try { return localStorage.getItem('sbs:' + k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem('sbs:' + k, v); } catch (e) { /* ignore */ } },
  };

  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { els.toast.hidden = true; }, 2200);
  }

  function parseUrl(raw) {
    raw = (raw || '').trim();
    if (!raw) return null;
    if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
    try { return new URL(raw); } catch (e) { return null; }
  }

  // Mirrors encodeSite/decodeSite in server.js.
  function encodeSite(origin) {
    var u = new URL(origin);
    return (u.protocol === 'http:' ? 'http:' : '') + u.host.toLowerCase();
  }
  function decodeSite(seg) {
    seg = decodeURIComponent(seg || '');
    return seg.indexOf('http:') === 0 ? 'http://' + seg.slice(5) : 'https://' + seg;
  }

  function normalizePath(p) {
    p = (p || '').trim();
    if (!p) return '/';
    if (/^https?:\/\//i.test(p)) {
      var u = new URL(p);
      return u.pathname + u.search + u.hash;
    }
    return p.charAt(0) === '/' ? p : '/' + p;
  }

  // --- loading -----------------------------------------------------------
  function load(role, path) {
    var pane = panes[role];
    pane.path = path;
    updateLabel(role);
    pane.iframe.src = '/x/' + encodeSite(pane.origin) + path;
  }

  function updateLabel(role) {
    var pane = panes[role];
    var full = pane.origin ? pane.origin + pane.path : '—';
    pane.urlLabel.textContent = full;
    pane.urlLabel.title = full;
    if (pane.origin) pane.openLink.href = full; else pane.openLink.removeAttribute('href');
  }

  function compare() {
    var live = parseUrl(els.liveUrl.value);
    var staging = parseUrl(els.stagingUrl.value);
    if (!live || !staging) { toast('Enter valid live and staging URLs'); return; }

    var path = els.path.value.trim();
    if (!path) {
      var livePath = live.pathname + live.search + live.hash;
      var stagingPath = staging.pathname + staging.search + staging.hash;
      path = livePath !== '/' ? livePath : stagingPath;
    }
    path = normalizePath(path);
    els.path.value = path === '/' ? '' : path;

    panes.live.origin = live.origin;
    panes.staging.origin = staging.origin;
    els.liveUrl.value = live.origin;
    els.stagingUrl.value = staging.origin;
    store.set('live', live.origin);
    store.set('staging', staging.origin);

    els.empty.hidden = true;
    leader = null;
    ROLES.forEach(function (r) { load(r, path); });
    syncQuery();
  }

  // --- messaging with the injected agent ---------------------------------
  function send(role, msg) {
    msg.__sbs = 1;
    var w = panes[role].iframe.contentWindow;
    if (w) w.postMessage(msg, location.origin);
  }

  function setLeader(role) {
    if (leader === role) return;
    leader = role;
    ROLES.forEach(function (r) { panes[r].el.classList.toggle('leader', r === role); });
  }

  window.addEventListener('message', function (e) {
    var msg = e.data;
    if (!msg || msg.__sbs !== 1) return;
    var role = null;
    ROLES.forEach(function (r) {
      if (e.source === panes[r].iframe.contentWindow && e.origin === location.origin) role = r;
    });
    if (!role) return;

    switch (msg.type) {
      case 'active':
        setLeader(role);
        break;

      case 'scroll':
        if ((pendingAlign && role === 'live') || (els.syncScroll.checked && role === leader)) {
          pendingAlign = false;
          send(other(role), {
            type: 'scrollTo',
            mode: els.scrollMode.value,
            x: msg.x, y: msg.y,
            rx: msg.maxX ? msg.x / msg.maxX : 0,
            ry: msg.maxY ? msg.y / msg.maxY : 0,
            selector: msg.selector,
          });
        }
        break;

      case 'nav':
        panes[role].path = msg.path;
        // The site can change on redirect, e.g. example.com -> www.example.com.
        if (msg.site) panes[role].origin = decodeSite(msg.site);
        updateLabel(role);
        if (role === leader) {
          els.path.value = msg.path === '/' ? '' : msg.path;
          syncQuery();
          if (els.syncNav.checked && panes[other(role)].path !== msg.path) {
            send(other(role), { type: 'navigate', path: msg.path });
          }
        }
        break;
    }
  });

  ROLES.forEach(function (role) {
    var pane = panes[role];
    pane.host.addEventListener('pointerenter', function () { setLeader(role); });
    pane.reload.addEventListener('click', function () {
      if (pane.origin) load(role, pane.path);
    });
  });

  els.align.addEventListener('click', function () {
    if (!panes.live.origin) return;
    pendingAlign = true;
    send('live', { type: 'ping' });
  });

  // --- viewport sizing ---------------------------------------------------
  function layoutViewports() {
    var vp = els.viewport.value;
    ROLES.forEach(function (role) {
      var pane = panes[role];
      var w = pane.host.clientWidth;
      var h = pane.host.clientHeight;
      if (!w || !h) return;
      var width = vp === 'fit' ? w : Number(vp);
      var scale = Math.min(1, w / width);
      pane.viewport.style.width = width + 'px';
      pane.viewport.style.height = (h / scale) + 'px';
      pane.viewport.style.transform = scale < 1 ? 'scale(' + scale + ')' : '';
      // Center narrow (mobile/tablet) viewports in the pane.
      pane.viewport.style.left = scale === 1 ? Math.max(0, (w - width) / 2) + 'px' : '0';
    });
  }
  var ro = new ResizeObserver(layoutViewports);
  ROLES.forEach(function (r) { ro.observe(panes[r].host); });

  function applyLayout() {
    var layout = els.layout.value;
    els.stage.classList.remove('split', 'stack', 'overlay');
    els.stage.classList.add(layout);
    var overlay = layout === 'overlay';
    els.overlayControls.hidden = !overlay;
    els.stage.classList.toggle('difference', overlay && els.difference.checked);
    panes.staging.viewport.style.opacity = overlay ? els.opacity.value / 100 : '';
    // In difference mode full opacity is what you want.
    if (overlay && els.difference.checked) panes.staging.viewport.style.opacity = 1;
    els.opacity.disabled = els.difference.checked;
    layoutViewports();
  }

  // --- shareable URL -----------------------------------------------------
  function syncQuery() {
    var q = new URLSearchParams();
    if (panes.live.origin) q.set('live', panes.live.origin);
    if (panes.staging.origin) q.set('staging', panes.staging.origin);
    var p = normalizePath(els.path.value);
    if (p !== '/') q.set('path', p);
    if (els.viewport.value !== 'fit') q.set('vp', els.viewport.value);
    if (els.layout.value !== 'split') q.set('layout', els.layout.value);
    if (els.scrollMode.value !== 'px') q.set('mode', els.scrollMode.value);
    var qs = q.toString();
    history.replaceState(null, '', qs ? '?' + qs : location.pathname);
  }

  els.share.addEventListener('click', function () {
    syncQuery();
    var url = location.href;
    (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject())
      .then(function () { toast('Link copied'); })
      .catch(function () { window.prompt('Copy this link:', url); });
  });

  // --- wiring ------------------------------------------------------------
  els.form.addEventListener('submit', function (e) { e.preventDefault(); compare(); });
  els.viewport.addEventListener('change', function () { store.set('vp', els.viewport.value); layoutViewports(); syncQuery(); });
  els.layout.addEventListener('change', function () { store.set('layout', els.layout.value); applyLayout(); syncQuery(); });
  els.scrollMode.addEventListener('change', function () { store.set('mode', els.scrollMode.value); syncQuery(); });
  els.opacity.addEventListener('input', applyLayout);
  els.difference.addEventListener('change', applyLayout);

  function setSelect(sel, value) {
    if (value && Array.prototype.some.call(sel.options, function (o) { return o.value === value; })) sel.value = value;
  }

  function init() {
    var q = new URLSearchParams(location.search);
    els.liveUrl.value = q.get('live') || store.get('live') || '';
    els.stagingUrl.value = q.get('staging') || store.get('staging') || '';
    els.path.value = q.get('path') || '';
    setSelect(els.viewport, q.get('vp') || store.get('vp'));
    setSelect(els.layout, q.get('layout') || store.get('layout'));
    setSelect(els.scrollMode, q.get('mode') || store.get('mode'));
    applyLayout();

    // The page itself is static; the proxy checks the team password.
    fetch('/__sbs/me', { credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 401) { location.href = '/__sbs/login'; return; }
        if (q.get('live') && q.get('staging')) compare();
      })
      .catch(function () { toast('Could not reach the Side by Side server'); });
  }

  init();
})();
