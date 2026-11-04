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
    scroll: 'Scroll to the spot, then pick <b>Callout</b> or <b>Box</b>. Drag a number to move it. Callouts stick to their spot on the page.',
    pin: 'Click on the page where the problem is. <b>Esc</b> to go back to scrolling.',
    box: 'Drag on the page to outline an area. <b>Esc</b> to go back to scrolling.',
  };
  function setTool(t) {
    tool = t;
    stage.dataset.tool = t;
    panel.querySelectorAll('[data-tool]').forEach(function (b) { b.classList.toggle('active', b.dataset.tool === t); });
    $('toolHint').innerHTML = hints[t];
  }
  panel.querySelectorAll('[data-tool]').forEach(function (b) {
    b.addEventListener('click', function () { setTool(b.dataset.tool); });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && tool !== 'scroll' && !dialog.open) setTool('scroll');
  });

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
    var onPage = pane.path === it.path;
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
  function addItem(role, kind, page, size) {
    var el = document.createElement('div');
    el.className = 'ann' + (kind === 'box' ? ' ann-box' : ' ann-pin');
    el.innerHTML = '<span class="ann-num" title="Drag to move"></span>' +
      '<div class="ann-bubble empty"><textarea rows="1" placeholder="Comment…"></textarea>' +
      '<button type="button" class="ann-del" title="Delete">×</button></div>';
    layers[role].appendChild(el);

    var item = {
      el: el, kind: kind, role: role, path: window.SBS.pane(role).path,
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
    el.querySelector('.ann-del').addEventListener('click', function () {
      el.remove();
      items.splice(items.indexOf(item), 1);
      renumber();
    });
    makeDraggable(item);
    ta.focus();
  }

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
      function move(ev) {
        item.px = ox + (ev.clientX - startX) / scale;
        item.py = oy + (ev.clientY - startY) / scale;
        render(item);
      }
      function up() {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
      }
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  ROLES.forEach(function (role) {
    var layer = layers[role];
    var draft = null;
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

  $('clearAnn').addEventListener('click', function () {
    if (items.length && !confirm('Remove all ' + items.length + ' annotations?')) return;
    items.forEach(function (it) { it.el.remove(); });
    items = [];
  });

  // --- notes as text -------------------------------------------------------
  function notesText() {
    var c = window.SBS.context();
    var lines = [
      '**Page:** ' + c.path,
      '**Live:** ' + c.live,
      '**Staging:** ' + c.staging,
      '**Viewport:** ' + c.viewport + ' · **Layout:** ' + c.layout,
      '**Compare:** ' + c.share,
    ];
    var notes = items.map(function (it, i) {
      var where = LABEL[it.role] + (it.path !== c.path ? ' ' + it.path : '');
      return (i + 1) + '. [' + where + '] ' + (it.textarea.value.trim() || '(no comment)');
    });
    if (notes.length) lines.push('', notes.join('\n'));
    if (summary.value.trim()) lines.push('', summary.value.trim());
    return lines.join('\n');
  }

  function copyText(text) {
    return navigator.clipboard.writeText(text).then(
      function () { toast('Notes copied'); },
      function () { window.prompt('Copy these notes:', text); });
  }
  $('copyNotes').addEventListener('click', function () { copyText(notesText()); });
  $('shotCopyNotes').addEventListener('click', function () { copyText(notesText()); });

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

  function compose(frame, crop, ratio) {
    var c = window.SBS.context();
    var s = ratio; // device pixels per CSS pixel in the captured frame
    var pad = 14 * s;
    var font = function (weight, size) { return weight + ' ' + Math.round(size * s) + 'px system-ui, -apple-system, Segoe UI, sans-serif'; };
    var W = crop.w;

    var measure = document.createElement('canvas').getContext('2d');
    measure.font = font(400, 13);
    var summaryLines = summary.value.trim() ? wrap(measure, summary.value.trim(), W - pad * 2) : [];
    var header = 58 * s;
    var footer = summaryLines.length ? pad * 2 + summaryLines.length * 18 * s : 0;

    var canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = header + crop.h + footer;
    var ctx = canvas.getContext('2d');

    ctx.fillStyle = '#111827';
    ctx.fillRect(0, 0, W, header);
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffffff';
    ctx.font = font(650, 14);
    ctx.fillText('Page ' + c.path, pad, 10 * s);
    ctx.font = font(400, 12);
    ctx.fillStyle = '#4ade80';
    var liveLabel = 'LIVE ' + c.live;
    ctx.fillText(liveLabel, pad, 32 * s);
    ctx.fillStyle = '#fbbf24';
    ctx.fillText('STAGING ' + c.staging, pad + ctx.measureText(liveLabel).width + 24 * s, 32 * s);
    ctx.fillStyle = '#9ca3af';
    var meta = c.viewport + ' · ' + new Date().toLocaleString();
    ctx.fillText(meta, W - pad - ctx.measureText(meta).width, 10 * s);

    ctx.drawImage(frame, crop.x, crop.y, crop.w, crop.h, 0, header, crop.w, crop.h);

    if (footer) {
      ctx.fillStyle = '#f9fafb';
      ctx.fillRect(0, header + crop.h, W, footer);
      ctx.fillStyle = '#111827';
      ctx.font = font(400, 13);
      summaryLines.forEach(function (l, i) { ctx.fillText(l, pad, header + crop.h + pad + i * 18 * s); });
    }
    return canvas;
  }

  $('captureBtn').addEventListener('click', function () {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      toast('Screenshots need Chrome or Edge on desktop');
      return;
    }
    var btn = this;
    btn.disabled = true;
    ensureStream()
      .then(function () {
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
        var r = stage.getBoundingClientRect();
        var crop = {
          x: Math.round(r.left * ratio), y: Math.round(r.top * ratio),
          w: Math.round(r.width * ratio), h: Math.round(r.height * ratio),
        };
        return compose(frame, crop, ratio);
      })
      .then(function (canvas) {
        return new Promise(function (res) { canvas.toBlob(res, 'image/png'); });
      })
      .then(function (blob) {
        var c = window.SBS.context();
        var slug = (c.path.replace(/[?#].*$/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home');
        var stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
        lastShot = { blob: blob, filename: 'sidebyside-' + slug + '-' + stamp + '.png' };
        if (shotImg.src) URL.revokeObjectURL(shotImg.src);
        shotImg.src = URL.createObjectURL(blob);
        dialog.showModal();
      })
      .catch(function (err) {
        if (err && err.message === 'wrong-surface') toast('Please choose “this tab” when the browser asks what to share');
        else if (err && err.name === 'NotAllowedError') toast('Screen capture was cancelled');
        else { console.error(err); toast('Could not take a screenshot'); }
      })
      .then(function () {
        document.body.classList.remove('capturing');
        btn.disabled = false;
      });
  });

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
