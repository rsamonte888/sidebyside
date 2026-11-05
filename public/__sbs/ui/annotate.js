// Annotate mode: numbered callouts and boxes drawn over both panes, a summary,
// and a screenshot of the comparison (via the browser's tab capture, so it is
// pixel-exact) with a header naming the page, URLs, viewport and date.
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var stage = $('stage');
  var panel = $('notesPanel');
  var openBtn = $('annotateBtn');
  var summary = $('summary');
  var dialog = $('shotDialog');
  var shotImg = $('shotImg');
  var toast = function (m) { window.SBS && window.SBS.toast(m); };
  var ROLES = ['live', 'staging'];
  var LABEL = { live: 'Live', staging: 'Staging' };

  var tool = 'scroll';
  // Each item is anchored to a spot on a page: { role, path, px, py, pw, ph }
  // in the page's own CSS pixels, so it moves with the page when it scrolls.
  var items = [];
  var stream = null;
  var video = null;
  var lastShot = null; // { blob, filename }

  // One annotation layer per pane, clipped to that pane.
  var layers = {};
  ROLES.forEach(function (role) {
    var host = document.querySelector('.pane[data-role="' + role + '"] .viewport-host');
    var layer = document.createElement('div');
    layer.className = 'ann-layer';
    layer.dataset.role = role;
    host.appendChild(layer);
    layers[role] = layer;
  });

  // --- open / close ------------------------------------------------------
  function setOpen(open) {
    panel.hidden = !open;
    openBtn.classList.toggle('active', open);
    if (!open) { setTool('scroll'); stopStream(); }
  }
  openBtn.addEventListener('click', function () { setOpen(panel.hidden); });
  $('annotateClose').addEventListener('click', function () { setOpen(false); });

  // --- tools -------------------------------------------------------------
  var hints = {
    scroll: 'Pick <b>Callout</b> or <b>Box</b>, then click or drag on the page. You can keep scrolling while a tool is on. Click a number for options (like a close-up screenshot), drag it to move. Callouts stick to their spot on the page.',
    pin: 'Click on the page where the problem is. <b>Esc</b> to go back to scrolling.',
    box: 'Drag on the page to outline an area. <b>Esc</b> to go back to scrolling.',
  };
  // A banner over the pages while a drawing tool is on, so it's clear how to stop.
  var banner = document.createElement('button');
  banner.type = 'button';
  banner.className = 'tool-banner';
  banner.hidden = true;
  stage.appendChild(banner);
  banner.addEventListener('click', function () { setTool('scroll'); });

  function setTool(t) {
    tool = t;
    stage.dataset.annTool = t;
    panel.querySelectorAll('[data-tool]').forEach(function (b) { b.classList.toggle('active', b.dataset.tool === t); });
    $('toolHint').innerHTML = hints[t];
    banner.hidden = t === 'scroll';
    banner.innerHTML = t === 'box'
      ? '<b>Box mode</b> drag on the page to draw · <u>Esc or click here to stop</u>'
      : '<b>Callout mode</b> click on the page to add · <u>Esc or click here to stop</u>';
  }
  panel.querySelectorAll('[data-tool]').forEach(function (b) {
    b.addEventListener('click', function () {
      // Clicking the active tool again turns it off.
      setTool(b.dataset.tool === tool && tool !== 'scroll' ? 'scroll' : b.dataset.tool);
    });
  });

  function escape() {
    if (dialog.open) return;
    closeMenus();
    if (tool !== 'scroll') setTool('scroll');
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') escape(); });
  window.addEventListener('sbs:escape', escape); // Esc pressed inside one of the sites

  // --- coordinates: layer (screen) <-> page ------------------------------
  function toPage(role, lx, ly) {
    var p = window.SBS.pane(role);
    return { x: (lx - p.geom.left) / p.geom.scale + p.scroll.x, y: ly / p.geom.scale + p.scroll.y };
  }
  function toLayer(role, px, py) {
    var p = window.SBS.pane(role);
    return { x: p.geom.left + (px - p.scroll.x) * p.geom.scale, y: (py - p.scroll.y) * p.geom.scale };
  }
  function localPoint(layer, e) {
    var r = layer.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function render(it) {
    var pane = window.SBS.pane(it.role);
    var onPage = pane.path === it.path && (!it.vp || it.vp === window.SBS.viewport());
    it.el.style.display = onPage ? '' : 'none';
    if (!onPage) return;
    var pos = toLayer(it.role, it.px, it.py);
    var scale = pane.geom.scale;
    it.el.style.left = pos.x + 'px';
    it.el.style.top = pos.y + 'px';
    var h = 0;
    if (it.kind === 'box') {
      it.el.style.width = it.pw * scale + 'px';
      it.el.style.height = (h = it.ph * scale) + 'px';
    }
    var layer = layers[it.role];
    it.el.classList.toggle('flip-x', pos.x + 260 > layer.clientWidth);
    it.el.classList.toggle('flip-y', pos.y + h + 120 > layer.clientHeight);
  }
  function renderAll(role) {
    items.forEach(function (it) { if (!role || it.role === role) render(it); });
  }
  ['sbs:scroll', 'sbs:nav'].forEach(function (ev) {
    window.addEventListener(ev, function (e) { renderAll(e.detail.role); });
  });
  window.addEventListener('sbs:layout', function () { renderAll(); });

  // --- creating annotations ---------------------------------------------
  function addItem(role, kind, page, size, opts) {
    opts = opts || {};
    var el = document.createElement('div');
    el.className = 'ann' + (kind === 'box' ? ' ann-box' : ' ann-pin');
    el.innerHTML = '<span class="ann-num" title="Click for options, drag to move"></span>' +
      '<div class="ann-bubble empty"><textarea rows="1" placeholder="Comment…"></textarea>' +
      '<button type="button" class="ann-more" title="More" aria-haspopup="menu">⋯</button>' +
      '<div class="ann-menu" role="menu" hidden>' +
      '<button type="button" role="menuitem" data-act="shot">Screenshot this</button>' +
      '<button type="button" role="menuitem" data-act="delete" class="danger">Delete</button>' +
      '</div></div>';
    layers[role].appendChild(el);

    var item = {
      el: el, kind: kind, role: role, path: opts.path || window.SBS.pane(role).path,
      // The viewport it was made at: layouts change between sizes, so a note
      // made on Mobile only shows on Mobile.
      vp: opts.vp !== undefined ? opts.vp : window.SBS.viewport(),
      px: page.x, py: page.y, pw: size ? size.w : 0, ph: size ? size.h : 0,
      textarea: el.querySelector('textarea'),
    };
    items.push(item);
    renumber();
    render(item);

    var ta = item.textarea;
    ta.addEventListener('input', function () {
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
      ta.parentNode.classList.toggle('empty', !ta.value.trim());
    });
    var menu = el.querySelector('.ann-menu');
    item.toggleMenu = function () {
      var open = menu.hidden;
      closeMenus();
      menu.hidden = !open;
    };
    el.querySelector('.ann-more').addEventListener('click', function (e) {
      e.stopPropagation();
      item.toggleMenu();
    });
    menu.addEventListener('click', function (e) {
      var act = e.target.dataset && e.target.dataset.act;
      if (!act) return;
      menu.hidden = true;
      if (act === 'delete') {
        el.remove();
        items.splice(items.indexOf(item), 1);
        renumber();
      } else if (act === 'shot') {
        screenshotItem(item);
      }
    });
    makeDraggable(item);
    if (opts.text) {
      ta.value = opts.text;
      ta.dispatchEvent(new Event('input'));
    }
    if (!opts.silent) ta.focus();
  }

  function closeMenus() {
    document.querySelectorAll('.ann-menu').forEach(function (m) { m.hidden = true; });
  }
  document.addEventListener('pointerdown', function (e) {
    if (!e.target.closest || !e.target.closest('.ann-menu, .ann-more, .ann-num')) closeMenus();
  });
  // Clicks inside a site happen in its iframe; the app only sees it lose focus.
  window.addEventListener('blur', closeMenus);

  function renumber() {
    items.forEach(function (it, i) { it.el.querySelector('.ann-num').textContent = i + 1; });
  }

  function makeDraggable(item) {
    var handle = item.el.querySelector('.ann-num');
    handle.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      var startX = e.clientX, startY = e.clientY, ox = item.px, oy = item.py;
      var scale = window.SBS.pane(item.role).geom.scale;
      var moved = false;
      function move(ev) {
        if (!moved && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 4) return;
        moved = true;
        item.px = ox + (ev.clientX - startX) / scale;
        item.py = oy + (ev.clientY - startY) / scale;
        render(item);
      }
      function up() {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        if (!moved) item.toggleMenu(); // a click, not a drag: open the menu
      }
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  ROLES.forEach(function (role) {
    var layer = layers[role];
    var draft = null;
    // The layer covers the page while a tool is on; pass the wheel through.
    layer.addEventListener('wheel', function (e) {
      if (tool === 'scroll') return;
      e.preventDefault();
      var k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? layer.clientHeight : 1;
      var scale = window.SBS.pane(role).geom.scale;
      window.SBS.scrollBy(role, e.deltaX * k / scale, e.deltaY * k / scale);
    }, { passive: false });
    layer.addEventListener('pointerdown', function (e) {
      if (e.target !== layer || tool === 'scroll') return;
      e.preventDefault(); // keep focus in the new comment box
      var p = localPoint(layer, e);
      if (tool === 'pin') { addItem(role, 'pin', toPage(role, p.x, p.y)); return; }
      layer.setPointerCapture(e.pointerId);
      draft = { x: p.x, y: p.y, el: document.createElement('div') };
      draft.el.className = 'draft';
      layer.appendChild(draft.el);
    });
    layer.addEventListener('pointermove', function (e) {
      if (!draft) return;
      var p = localPoint(layer, e);
      Object.assign(draft.el.style, {
        left: Math.min(p.x, draft.x) + 'px', top: Math.min(p.y, draft.y) + 'px',
        width: Math.abs(p.x - draft.x) + 'px', height: Math.abs(p.y - draft.y) + 'px',
      });
    });
    layer.addEventListener('pointerup', function (e) {
      if (!draft) return;
      var p = localPoint(layer, e);
      var x = Math.min(p.x, draft.x), y = Math.min(p.y, draft.y);
      var w = Math.abs(p.x - draft.x), h = Math.abs(p.y - draft.y);
      draft.el.remove();
      draft = null;
      if (w > 8 && h > 8) {
        var scale = window.SBS.pane(role).geom.scale;
        addItem(role, 'box', toPage(role, x, y), { w: w / scale, h: h / scale });
      }
    });
  });

  // --- save / load (used by share links) ------------------------------------
  window.SBS.annotations = {
    count: function () { return items.length; },
    save: function () {
      if (!items.length && !summary.value.trim()) return null;
      return {
        v: 1,
        items: items.map(function (it) {
          return {
            r: it.role === 'live' ? 'l' : 's', k: it.kind === 'box' ? 'b' : 'p', p: it.path,
            x: Math.round(it.px), y: Math.round(it.py), w: Math.round(it.pw), h: Math.round(it.ph),
            t: it.textarea.value, v: it.vp,
          };
        }),
        sum: summary.value,
      };
    },
    load: function (data) {
      if (!data || data.v !== 1) return;
      (data.items || []).forEach(function (d) {
        addItem(d.r === 'l' ? 'live' : 'staging', d.k === 'b' ? 'box' : 'pin', { x: d.x, y: d.y },
          d.k === 'b' ? { w: d.w, h: d.h } : null, { path: d.p, text: d.t, silent: true, vp: d.v || '' });
      });
      if (data.sum) summary.value = data.sum;
      setOpen(true);
    },
  };

  $('clearAnn').addEventListener('click', function () {
    if (items.length && !confirm('Remove all ' + items.length + ' annotations?')) return;
    items.forEach(function (it) { it.el.remove(); });
    items = [];
  });

  // --- notes as text -------------------------------------------------------
  function itemNote(it, i, currentPath) {
    var where = LABEL[it.role] + (it.path !== currentPath ? ' ' + it.path : '');
    return (i + 1) + '. [' + where + '] ' + (it.textarea.value.trim() || '(no comment)');
  }

  function notesText(link) {
    var c = window.SBS.context();
    var lines = [
      '**Page:** ' + c.path,
      c.live && '**Live:** ' + c.live,
      c.staging && '**Staging:** ' + c.staging,
      '**Viewport:** ' + c.viewport + ' · **Layout:** ' + c.layout,
      '**Compare:** ' + (link || c.share),
    ].filter(Boolean);
    var notes = items.map(function (it, i) { return itemNote(it, i, c.path); });
    if (notes.length) lines.push('', notes.join('\n'));
    if (summary.value.trim()) lines.push('', summary.value.trim());
    return lines.join('\n');
  }

  function copyText(text) {
    return navigator.clipboard.writeText(text).then(
      function () { toast('Notes copied'); },
      function () { window.prompt('Copy these notes:', text); });
  }
  function copyNotes() {
    window.SBS.shareUrl().then(function (url) { copyText(notesText(url)); });
  }
  $('copyNotes').addEventListener('click', copyNotes);
  $('shotCopyNotes').addEventListener('click', copyNotes);

  // --- screenshot ----------------------------------------------------------
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function frames(n) {
    return new Promise(function (r) {
      (function tick() { if (n-- <= 0) r(); else requestAnimationFrame(tick); })();
    });
  }

  function stopStream() {
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
    video = null;
  }

  function ensureStream() {
    if (stream && stream.active) return Promise.resolve();
    return navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser', frameRate: 10 },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      surfaceSwitching: 'exclude',
    }).then(function (s) {
      stream = s;
      s.getVideoTracks()[0].addEventListener('ended', function () { stream = null; video = null; });
      video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = s;
      return video.play();
    }).then(function () { return wait(400); }); // let the "sharing" bar settle
  }

  function wrap(ctx, text, maxWidth) {
    var out = [];
    String(text).split('\n').forEach(function (para) {
      var line = '';
      para.split(/\s+/).forEach(function (word) {
        var test = line ? line + ' ' + word : word;
        if (ctx.measureText(test).width > maxWidth && line) { out.push(line); line = word; } else line = test;
      });
      out.push(line);
    });
    return out;
  }

  // Draw the header, one or more crops of the captured frame side by side,
  // and an optional footer. crops: [{ x, y, w, h, label?, color? }] in frame px.
  function compose(frame, crops, ratio, footerText) {
    var c = window.SBS.context();
    var s = ratio; // device pixels per CSS pixel in the captured frame
    var pad = 14 * s;
    var gap = crops.length > 1 ? 12 * s : 0;
    var labelH = crops.some(function (k) { return k.label; }) ? 26 * s : 0;
    var font = function (weight, size) { return weight + ' ' + Math.round(size * s) + 'px system-ui, -apple-system, Segoe UI, sans-serif'; };

    var cropsW = crops.reduce(function (sum, k) { return sum + k.w; }, 0) + gap * (crops.length - 1);
    var W = Math.max(cropsW + (crops.length > 1 ? pad * 2 : 0), 560 * s);
    var cropsH = Math.max.apply(null, crops.map(function (k) { return k.h; }));

    var measure = document.createElement('canvas').getContext('2d');
    measure.font = font(400, 13);
    var footerLines = footerText ? wrap(measure, footerText, W - pad * 2) : [];
    var header = 58 * s;
    var bodyPad = crops.length > 1 ? pad : 0;
    var body = labelH + cropsH + bodyPad * 2;
    var footer = footerLines.length ? pad * 2 + footerLines.length * 18 * s : 0;

    var canvas = document.createElement('canvas');
    canvas.width = Math.round(W);
    canvas.height = Math.round(header + body + footer);
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = crops.length > 1 ? '#e5e7eb' : '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // header
    ctx.fillStyle = '#111827';
    ctx.fillRect(0, 0, W, header);
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffffff';
    ctx.font = font(650, 14);
    ctx.fillText('Page ' + c.path, pad, 10 * s);
    ctx.font = font(400, 12);
    ctx.fillStyle = '#4ade80';
    var liveLabel = c.live ? 'LIVE ' + c.live : '';
    if (liveLabel) ctx.fillText(liveLabel, pad, 32 * s);
    ctx.fillStyle = '#fbbf24';
    if (c.staging) ctx.fillText('STAGING ' + c.staging, pad + (liveLabel ? ctx.measureText(liveLabel).width + 24 * s : 0), 32 * s);
    ctx.fillStyle = '#9ca3af';
    var meta = c.viewport + ' · ' + new Date().toLocaleString();
    ctx.fillText(meta, W - pad - ctx.measureText(meta).width, 10 * s);

    // crops, centred
    var x = (W - cropsW) / 2;
    crops.forEach(function (k) {
      var y = header + bodyPad;
      if (k.label) {
        ctx.font = font(700, 12);
        ctx.fillStyle = k.color || '#111827';
        ctx.fillText(k.label, x, y + 5 * s);
        y += labelH;
      }
      ctx.drawImage(frame, k.x, k.y, k.w, k.h, x, y, k.w, k.h);
      if (crops.length > 1) {
        ctx.strokeStyle = 'rgba(0,0,0,.15)';
        ctx.lineWidth = s;
        ctx.strokeRect(x, y, k.w, k.h);
      }
      x += k.w + gap;
    });

    if (footer) {
      var fy = header + body;
      ctx.fillStyle = '#f9fafb';
      ctx.fillRect(0, fy, W, footer);
      ctx.fillStyle = '#111827';
      ctx.font = font(400, 13);
      footerLines.forEach(function (l, i) { ctx.fillText(l, pad, fy + pad + i * 18 * s); });
    }
    return canvas;
  }

  // Capture the current tab as a canvas. Resolves { frame, ratio }.
  function grabFrame() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      return Promise.reject(new Error('unsupported'));
    }
    return ensureStream()
      .then(function () {
        closeMenus();
        document.body.classList.add('capturing');
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        return frames(2).then(function () { return wait(200); });
      })
      .then(function () {
        var vw = video.videoWidth, vh = video.videoHeight;
        var ratio = vw / window.innerWidth;
        // If the user picked another tab or window, the frame won't match this page.
        if (!vw || Math.abs(vh / ratio - window.innerHeight) > 40) {
          stopStream();
          throw new Error('wrong-surface');
        }
        var frame = document.createElement('canvas');
        frame.width = vw;
        frame.height = vh;
        frame.getContext('2d').drawImage(video, 0, 0);
        return { frame: frame, ratio: ratio };
      })
      .finally(function () { document.body.classList.remove('capturing'); });
  }

  function toFrame(r, ratio) {
    return {
      x: Math.round(r.left * ratio), y: Math.round(r.top * ratio),
      w: Math.round(r.width * ratio), h: Math.round(r.height * ratio),
    };
  }

  function showShot(canvas, name) {
    return new Promise(function (res) { canvas.toBlob(res, 'image/png'); }).then(function (blob) {
      var c = window.SBS.context();
      var slug = (c.path.replace(/[?#].*$/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home');
      var stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      lastShot = { blob: blob, filename: 'sidebyside-' + slug + (name ? '-' + name : '') + '-' + stamp + '.png' };
      if (shotImg.src) URL.revokeObjectURL(shotImg.src);
      shotImg.src = URL.createObjectURL(blob);
      dialog.showModal();
    });
  }

  function captureError(err) {
    if (err && err.message === 'unsupported') toast('Screenshots need Chrome or Edge on desktop');
    else if (err && err.message === 'wrong-surface') toast('Please choose “this tab” when the browser asks what to share');
    else if (err && err.name === 'NotAllowedError') toast('Screen capture was cancelled');
    else { console.error(err); toast('Could not take a screenshot'); }
  }

  // Whole comparison
  $('captureBtn').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    grabFrame()
      .then(function (g) {
        var canvas = compose(g.frame, [toFrame(stage.getBoundingClientRect(), g.ratio)], g.ratio, summary.value.trim());
        return showShot(canvas);
      })
      .catch(captureError)
      .then(function () { btn.disabled = false; });
  });

  // Close-up of one annotation, with the same spot on the other site beside it.
  function screenshotItem(item) {
    var host = layers[item.role].parentNode;
    var hostRect = host.getBoundingClientRect();
    var parts = [item.el, item.el.querySelector('.ann-num'), item.el.querySelector('.ann-bubble')];
    var r = parts.reduce(function (u, el) {
      var b = el.getBoundingClientRect();
      if (!b.width && !b.height) return u;
      return u ? {
        left: Math.min(u.left, b.left), top: Math.min(u.top, b.top),
        right: Math.max(u.right, b.right), bottom: Math.max(u.bottom, b.bottom),
      } : { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    }, null);
    var PAD = 90;
    // Area around the annotation, relative to its pane, kept inside the pane.
    var rel = {
      left: Math.max(0, r.left - PAD - hostRect.left),
      top: Math.max(0, r.top - PAD - hostRect.top),
      right: Math.min(hostRect.width, r.right + PAD - hostRect.left),
      bottom: Math.min(hostRect.height, r.bottom + PAD - hostRect.top),
    };

    // The other site, if it's on screen next to this one (not overlay / single view).
    var otherRole = item.role === 'live' ? 'staging' : 'live';
    var otherHost = layers[otherRole].parentNode;
    var otherRect = otherHost.getBoundingClientRect();
    var otherVisible = !stage.classList.contains('overlay') && !stage.classList.contains('solo') &&
      otherRect.width > 0 && getComputedStyle(otherHost.closest('.pane')).visibility === 'visible';
    if (otherVisible) {
      rel.right = Math.min(rel.right, otherRect.width);
      rel.bottom = Math.min(rel.bottom, otherRect.height);
    }
    var at = function (base) {
      return { left: base.left + rel.left, top: base.top + rel.top, width: rel.right - rel.left, height: rel.bottom - rel.top };
    };

    var index = items.indexOf(item);
    grabFrame()
      .then(function (g) {
        var mine = toFrame(at(hostRect), g.ratio);
        var crops;
        if (otherVisible) {
          var theirs = toFrame(at(otherRect), g.ratio);
          var live = item.role === 'live' ? mine : theirs;
          var staging = item.role === 'live' ? theirs : mine;
          live.label = 'LIVE'; live.color = '#15803d';
          staging.label = 'STAGING'; staging.color = '#b45309';
          crops = [live, staging];
        } else {
          mine.label = LABEL[item.role].toUpperCase();
          mine.color = item.role === 'live' ? '#15803d' : '#b45309';
          crops = [mine];
        }
        var canvas = compose(g.frame, crops, g.ratio, itemNote(item, index, window.SBS.context().path));
        return showShot(canvas, 'note-' + (index + 1));
      })
      .catch(captureError);
  }

  // --- preview dialog --------------------------------------------------------
  dialog.querySelector('[data-close]').addEventListener('click', function () { dialog.close(); });
  dialog.addEventListener('click', function (e) { if (e.target === dialog) dialog.close(); });

  $('shotCopy').addEventListener('click', function () {
    if (!lastShot) return;
    if (!window.ClipboardItem) { toast('Copying images isn’t supported here, use Download'); return; }
    navigator.clipboard.write([new ClipboardItem({ 'image/png': lastShot.blob })]).then(
      function () { toast('Image copied, paste it into the ticket'); },
      function () { toast('Couldn’t copy, use Download instead'); });
  });

  $('shotDownload').addEventListener('click', function () {
    if (!lastShot) return;
    var a = document.createElement('a');
    a.href = URL.createObjectURL(lastShot.blob);
    a.download = lastShot.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });

  window.addEventListener('beforeunload', stopStream);
})();
