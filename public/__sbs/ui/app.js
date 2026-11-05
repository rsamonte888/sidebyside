(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var ROLES = ['live', 'staging'];

  var els = {
    form: $('form'), liveUrl: $('liveUrl'), stagingUrl: $('stagingUrl'), path: $('path'),
    syncScroll: $('syncScroll'), scrollMode: $('scrollMode'), syncNav: $('syncNav'), syncClicks: $('syncClicks'),
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
      scroll: { x: 0, y: 0 },   // the page's scroll position (CSS px)
      geom: { left: 0, scale: 1 }, // where the page sits inside the pane
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
  function emit(name, role) {
    window.dispatchEvent(new CustomEvent('sbs:' + name, { detail: { role: role } }));
  }

  // --- Figma ---------------------------------------------------------------
  // A Figma frame link in either box shows that frame as an image (rendered
  // by the server through the Figma API) instead of a website.
  function isFigma(raw) { return /^(https?:\/\/)?([\w-]+\.)?figma\.com\/(design|file|proto)\//i.test((raw || '').trim()); }
  function figmaUrl(raw) { raw = raw.trim(); return /^https?:\/\//i.test(raw) ? raw : 'https://' + raw; }
  var DESIGN_PATH = '/__design';

  // A Figma link opens the frame picker; the picked frame is pane.figma and its
  // Desktop / Tablet / Mobile siblings from the same section are pane.fset.
  var DEVICES = ['desktop', 'tablet', 'mobile'];
  var pendingFset = null; // from a shared link

  function frameLink(key, id) { return 'https://www.figma.com/design/' + key + '/?node-id=' + id.replace(':', '-'); }
  function baseName(n) {
    return (n || '').toLowerCase().replace(/(^|[^a-z])(mobile|tablet|desktop)(?![a-z])/g, ' ').replace(/[\s\/_\-.]+/g, ' ').trim();
  }
  /** The frame for each device that matches the picked one (same name minus the device word). */
  function siblingsFor(group, frame) {
    var out = {};
    var base = baseName(frame.name);
    var of = function (d) { return group.frames.filter(function (f) { return f.device === d; }); };
    var mine = of(frame.device).filter(function (f) { return baseName(f.name) === base; });
    var ord = Math.max(0, mine.indexOf(frame));
    DEVICES.forEach(function (d) {
      var all = of(d);
      if (!all.length) return;
      if (d === frame.device) { out[d] = frame; return; }
      var same = all.filter(function (f) { return baseName(f.name) === base; });
      out[d] = same[Math.min(ord, same.length - 1)] || all[0];
    });
    return out;
  }

  function designRole() {
    return panes.live.figmaSource ? 'live' : panes.staging.figmaSource ? 'staging' : null;
  }

  function applyPick(role, pick) {
    var pane = panes[role];
    var frames = siblingsFor(pick.group, pick.frame);
    pane.fset = {
      source: pane.figmaSource,
      key: pick.key,
      name: pick.group.trail.concat(pick.group.name).join(' › '),
      frames: {},
    };
    DEVICES.forEach(function (d) { if (frames[d]) pane.fset.frames[d] = { id: frames[d].id, name: frames[d].name }; });
    showDevice(role, pick.frame.device);
  }

  function showDevice(role, device) {
    var pane = panes[role];
    if (!pane.fset || !pane.fset.frames[device]) return;
    pane.device = device;
    pane.figma = frameLink(pane.fset.key, pane.fset.frames[device].id);
    load(role, DESIGN_PATH);
    updateDesignControls();
    syncQuery();
  }

  function openPicker(role, auto) {
    var pane = panes[role];
    var cur = pane.fset && pane.fset.frames[pane.device];
    window.SBS.picker.open(pane.figmaSource, function (pick) { applyPick(role, pick); },
      { auto: auto, current: cur && cur.id });
  }

  var designControls = $('designControls');
  var deviceButtons = designControls.querySelectorAll('[data-device]');
  function updateDesignControls() {
    var role = designRole();
    var pane = role && panes[role];
    designControls.hidden = !pane;
    if (!pane) return;
    deviceButtons.forEach(function (b) {
      var f = pane.fset && pane.fset.frames[b.dataset.device];
      b.disabled = !f;
      b.classList.toggle('active', !!f && pane.device === b.dataset.device);
      b.title = f ? f.name || b.dataset.device : 'No ' + b.dataset.device + ' frame in this section';
    });
  }
  deviceButtons.forEach(function (b) {
    b.addEventListener('click', function () { var r = designRole(); if (r) showDevice(r, b.dataset.device); });
  });
  $('framesBtn').addEventListener('click', function () { var r = designRole(); if (r) openPicker(r, false); });

  function setKind(role, figma) {
    var pane = panes[role];
    if ((figma || null) !== (pane.figmaSource || null)) {
      // A different Figma link (or none): forget the picked frame.
      pane.fset = null;
      pane.figma = null;
      pane.device = null;
    }
    pane.figmaSource = figma || null;
    var tag = pane.el.querySelector('.pane-bar .tag');
    tag.textContent = figma ? 'Design' : (role === 'live' ? 'Live' : 'Staging');
    tag.classList.toggle('design', !!figma);
  }

  function load(role, path) {
    var pane = panes[role];
    var frame = pane.fset && pane.fset.frames[pane.device];
    pane.path = pane.figmaSource ? DESIGN_PATH + '/' + (frame ? frame.id : '') : path;
    pane.scroll = { x: 0, y: 0 };
    emit('nav', role);
    updateLabel(role);
    if (pane.figmaSource && !pane.figma) {
      pane.iframe.removeAttribute('src'); // waiting for a frame to be picked
      return;
    }
    pane.iframe.src = pane.figma
      ? '/__sbs/ui/design.html?figma=' + encodeURIComponent(pane.figma)
      : '/x/' + encodeSite(pane.origin) + path;
  }

  function fullUrl(role) {
    var pane = panes[role];
    if (pane.figma) return pane.figma;
    return pane.origin ? pane.origin + pane.path : '';
  }

  function updateLabel(role) {
    var pane = panes[role];
    var full = fullUrl(role) || '—';
    var text = full;
    if (pane.figmaSource) {
      var f = pane.fset && pane.fset.frames[pane.device];
      text = f ? pane.fset.name + ' · ' + (f.name || pane.device) : 'Pick a frame…';
      if (!f) full = pane.figmaSource;
    }
    pane.urlLabel.textContent = text;
    pane.urlLabel.title = full;
    if (full !== '—') pane.openLink.href = full; else pane.openLink.removeAttribute('href');
  }

  function compare() {
    var inputs = { live: els.liveUrl, staging: els.stagingUrl };
    var urls = {};
    var ok = true;
    // Leave one box empty to load just one site (e.g. production, to annotate it).
    var filled = ROLES.filter(function (r) { return inputs[r].value.trim(); });
    if (!filled.length) { toast('Enter a URL, or two to compare'); return; }
    ROLES.forEach(function (r) {
      var raw = inputs[r].value;
      urls[r] = null;
      if (filled.indexOf(r) < 0) { setKind(r, null); return; }
      if (isFigma(raw)) { setKind(r, figmaUrl(raw)); return; }
      setKind(r, null);
      urls[r] = parseUrl(raw);
      if (!urls[r]) ok = false;
    });
    if (!ok) { toast('Enter a valid URL or a Figma frame link'); return; }
    if (panes.live.figmaSource && panes.staging.figmaSource) { toast('Compare a Figma design with a website, not two designs'); return; }
    setSingle(filled.length === 1 ? filled[0] : null);

    var path = els.path.value.trim();
    if (!path) {
      var pathOf = function (u) { return u ? u.pathname + u.search + u.hash : '/'; };
      var livePath = pathOf(urls.live);
      path = livePath !== '/' ? livePath : pathOf(urls.staging);
    }
    path = normalizePath(path);
    els.path.value = path === '/' ? '' : path;

    ROLES.forEach(function (r) {
      var value = panes[r].figmaSource || (urls[r] ? urls[r].origin : '');
      panes[r].origin = urls[r] ? urls[r].origin : null;
      inputs[r].value = value;
      store.set(r, value);
    });

    els.empty.hidden = true;
    leader = null;
    // A shared link carries the picked frames, so no need to pick again.
    var dr = designRole();
    if (dr && pendingFset && pendingFset.source === panes[dr].figmaSource) {
      panes[dr].fset = pendingFset;
      panes[dr].device = pendingFset.frames[pendingFset.device] ? pendingFset.device : Object.keys(pendingFset.frames)[0];
      panes[dr].figma = frameLink(pendingFset.key, panes[dr].fset.frames[panes[dr].device].id);
    }
    pendingFset = null;
    updateDesignControls();

    ROLES.forEach(function (r) {
      if (panes[r].origin || panes[r].figmaSource) return load(r, path);
      // Not used in single-site mode.
      panes[r].path = '/';
      panes[r].iframe.removeAttribute('src');
      updateLabel(r);
    });
    syncQuery();
    if (dr && !panes[dr].figma) openPicker(dr, true);
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

      case 'click':
        if (role === leader && els.syncClicks.checked && !designRole()) {
          send(other(role), { type: 'click', tag: msg.tag, text: msg.text, index: msg.index, path: msg.path });
        }
        break;

      case 'design':
        // Match the viewport to the Figma frame's width so they line up 1:1.
        if (msg.width) {
          var w = String(msg.width);
          var opt = Array.prototype.find.call(els.viewport.options, function (o) { return o.value === w; });
          if (!opt) {
            opt = new Option('Design ' + w, w);
            els.viewport.add(opt, 1);
          }
          if (els.viewport.value !== w) {
            els.viewport.value = w;
            layoutViewports();
            syncQuery();
            toast('Viewport set to ' + w + 'px to match the Figma frame');
          }
        }
        break;

      case 'escape':
        emit('escape', role);
        break;

      case 'clickMissed':
        toast('Couldn’t find ' + (msg.text ? '“' + msg.text.slice(0, 40) + '”' : 'that element') +
          ' on ' + (role === 'live' ? 'live' : 'staging'));
        break;

      case 'scroll':
        panes[role].scroll = { x: msg.x, y: msg.y };
        emit('scroll', role);
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
        if (panes[role].figmaSource) break; // a design has no pages
        if (panes[role].path !== msg.path) panes[role].scroll = { x: 0, y: 0 };
        panes[role].path = msg.path;
        emit('nav', role);
        tryRestore(role);
        // The site can change on redirect, e.g. example.com -> www.example.com.
        if (msg.site) panes[role].origin = decodeSite(msg.site);
        updateLabel(role);
        if (role === leader) {
          els.path.value = msg.path === '/' ? '' : msg.path;
          syncQuery();
          if (els.syncNav.checked && !panes[other(role)].figmaSource && panes[other(role)].path !== msg.path) {
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
      var left = scale === 1 ? Math.max(0, (w - width) / 2) : 0;
      pane.viewport.style.left = left + 'px';
      pane.geom = { left: left, scale: scale };
    });
    emit('layout');
  }
  var ro = new ResizeObserver(layoutViewports);
  ROLES.forEach(function (r) { ro.observe(panes[r].host); });

  // --- view: both panes, or one pane full width ---------------------------
  // The hidden pane keeps loading and syncing out of sight, so switching
  // back to "Both" lines up immediately.
  var view = 'both';
  var viewButtons = document.querySelectorAll('[data-view]');

  // Single-site mode: only one URL was entered, so only that pane is shown.
  var single = null;
  function setSingle(role) {
    var was = single;
    single = role;
    document.body.classList.toggle('single-site', !!role);
    viewButtons.forEach(function (b) {
      b.disabled = !!role && b.dataset.view !== role;
      b.title = b.disabled ? 'Enter both URLs to compare' : '';
    });
    if (role) setView(role);
    else if (was) setView('both');
  }

  function setView(v, initial) {
    if (single) v = single;
    view = v === 'live' || v === 'staging' ? v : 'both';
    store.set('view', view);
    viewButtons.forEach(function (b) { b.classList.toggle('active', b.dataset.view === view); });
    ROLES.forEach(function (r) {
      var btn = panes[r].el.querySelector('[data-solo]');
      var solo = view === r;
      btn.textContent = solo ? '⤡' : '⤢';
      btn.title = solo ? 'Show both' : 'Full view';
    });
    if (view !== 'both') setLeader(view);
    applyLayout();
    if (!initial) syncQuery();
  }
  viewButtons.forEach(function (b) {
    b.addEventListener('click', function () { setView(b.dataset.view); });
  });
  ROLES.forEach(function (r) {
    panes[r].el.querySelector('[data-solo]').addEventListener('click', function () {
      setView(view === r ? 'both' : r);
    });
  });

  function applyLayout() {
    // A single pane is always shown full size, whatever the layout.
    var solo = view !== 'both';
    var layout = solo ? 'split' : els.layout.value;
    els.stage.classList.remove('split', 'stack', 'overlay', 'solo', 'solo-live', 'solo-staging');
    els.stage.classList.add(layout);
    if (solo) els.stage.classList.add('solo', 'solo-' + view);
    els.layout.disabled = solo;
    els.layout.title = solo ? 'Switch the view back to Both to change the layout' : '';
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
    ROLES.forEach(function (r) {
      var v = panes[r].figmaSource || panes[r].origin;
      if (v) q.set(r, v);
    });
    var dpane = designRole() && panes[designRole()];
    if (dpane && dpane.fset) {
      q.set('fk', dpane.fset.key);
      q.set('fn', dpane.fset.name);
      DEVICES.forEach(function (d) { if (dpane.fset.frames[d]) q.set('f' + d[0], dpane.fset.frames[d].id); });
      q.set('fdev', dpane.device);
    }
    var p = normalizePath(els.path.value);
    if (p !== '/') q.set('path', p);
    if (els.viewport.value !== 'fit') q.set('vp', els.viewport.value);
    if (els.layout.value !== 'split') q.set('layout', els.layout.value);
    if (els.scrollMode.value !== 'px') q.set('mode', els.scrollMode.value);
    if (view !== 'both') q.set('view', view);
    var qs = q.toString();
    history.replaceState(null, '', qs ? '?' + qs : location.pathname);
  }

  // --- annotations in the link ------------------------------------------------
  // The annotations, summary and both scroll positions are packed into an
  // `ann` parameter (deflate + base64url), so the link opens the same screen.
  function b64url(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64url(s) {
    var bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function pipe(bytes, stream) {
    return new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer()
      .then(function (b) { return new Uint8Array(b); });
  }
  function encodeState(obj) {
    var bytes = new TextEncoder().encode(JSON.stringify(obj));
    if (!window.CompressionStream) return Promise.resolve('j' + b64url(bytes));
    return pipe(bytes, new CompressionStream('deflate-raw')).then(function (z) { return 'z' + b64url(z); });
  }
  function decodeState(s) {
    var bytes = unb64url(s.slice(1));
    var p = s[0] === 'z' ? pipe(bytes, new DecompressionStream('deflate-raw')) : Promise.resolve(bytes);
    return p.then(function (b) { return JSON.parse(new TextDecoder().decode(b)); });
  }

  function shareUrl() {
    syncQuery();
    var base = location.href;
    var ann = window.SBS.annotations && window.SBS.annotations.save();
    if (!ann) return Promise.resolve(base);
    ann.sc = {};
    ROLES.forEach(function (r) { ann.sc[r] = [Math.round(panes[r].scroll.x), Math.round(panes[r].scroll.y)]; });
    return encodeState(ann).then(function (enc) {
      return base + (base.indexOf('?') >= 0 ? '&' : '?') + 'ann=' + enc;
    });
  }

  // Restoring scroll from a link: pages may still be loading content, so retry.
  var restore = null; // { live: [x, y], staging: [x, y] }
  function tryRestore(role) {
    if (!restore || !restore[role] || !panes[role].origin) return;
    var target = restore[role];
    var attempts = 0;
    (function attempt() {
      if (!restore || restore[role] !== target) return;
      var s = panes[role].scroll;
      if (Math.abs(s.y - target[1]) < 2 && Math.abs(s.x - target[0]) < 2) { delete restore[role]; return; }
      if (attempts++ > 8) { delete restore[role]; return; }
      send(role, { type: 'scrollTo', mode: 'px', x: target[0], y: target[1] });
      setTimeout(attempt, 400 + attempts * 200);
    })();
  }

  els.share.addEventListener('click', function () {
    shareUrl().then(function (url) {
      return (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject())
        .then(function () {
          var n = window.SBS.annotations ? window.SBS.annotations.count() : 0;
          toast(n ? 'Link copied with ' + n + ' annotation' + (n > 1 ? 's' : '') : 'Link copied');
          if (url.length > 8000) setTimeout(function () { toast('Heads up: this link is very long, some apps may cut it off'); }, 2400);
        })
        .catch(function () { window.prompt('Copy this link:', url); });
    });
  });

  // Relabel an input as "Design" while it holds a Figma link.
  [[els.liveUrl, 'Live'], [els.stagingUrl, 'Staging']].forEach(function (pair) {
    var tag = pair[0].parentNode.querySelector('.tag');
    var update = function () {
      var fig = isFigma(pair[0].value);
      tag.textContent = fig ? 'Design' : pair[1];
      tag.classList.toggle('design', fig);
    };
    pair[0].addEventListener('input', update);
    pair[0].addEventListener('change', update);
    window.addEventListener('load', update);
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
    if (q.get('fk') && (q.get('fd') || q.get('ft') || q.get('fm'))) {
      var src = [q.get('live'), q.get('staging')].filter(isFigma)[0];
      if (src) {
        pendingFset = { source: figmaUrl(src), key: q.get('fk'), name: q.get('fn') || 'Figma', frames: {}, device: q.get('fdev') };
        DEVICES.forEach(function (d) { var id = q.get('f' + d[0]); if (id) pendingFset.frames[d] = { id: id, name: '' }; });
      }
    }
    setSelect(els.viewport, q.get('vp') || store.get('vp'));
    setSelect(els.layout, q.get('layout') || store.get('layout'));
    setSelect(els.scrollMode, q.get('mode') || store.get('mode'));
    setView(q.get('view') || store.get('view'), true);

    // The page itself is static; the proxy checks the team password.
    fetch('/__sbs/me', { credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 401) {
          // Come back to this exact link (with its annotations) after signing in.
          location.href = '/__sbs/login?next=' + encodeURIComponent(location.pathname + location.search);
          return;
        }
        if (q.get('live') || q.get('staging')) compare();
        if (q.get('ann')) {
          decodeState(q.get('ann')).then(function (data) {
            restore = data.sc || null;
            if (window.SBS.annotations) window.SBS.annotations.load(data);
            ROLES.forEach(tryRestore);
          }).catch(function () { toast('Couldn’t read the annotations in this link'); });
        }
      })
      .catch(function () { toast('Could not reach the Side by Side server'); });
  }

  // Used by annotate.js to label screenshots and notes.
  window.SBS = {
    toast: toast,
    pane: function (role) {
      var p = panes[role];
      return { host: p.host, path: p.path, scroll: p.scroll, geom: p.geom, origin: p.origin };
    },
    context: function () {
      syncQuery();
      var opt = function (sel) { return sel.options[sel.selectedIndex].text; };
      return {
        live: (panes.live.figmaSource ? 'Figma ' : '') + fullUrl('live'),
        staging: (panes.staging.figmaSource ? 'Figma ' : '') + fullUrl('staging'),
        path: (single ? panes[single].path : panes.live.figmaSource ? panes.staging.path : panes.live.path) || '/',
        viewport: opt(els.viewport),
        layout: opt(els.layout),
        share: location.href,
      };
    },
    shareUrl: function () { return shareUrl(); },
    viewport: function () { return els.viewport.value; },
    scrollBy: function (role, dx, dy) {
      setLeader(role); // so the other side follows
      send(role, { type: 'scrollBy', dx: dx, dy: dy });
    },
  };

  init();
})();
