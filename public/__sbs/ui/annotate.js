// Annotate mode: numbered callouts and boxes drawn over both panes, a summary,
// and a screenshot of the comparison (via the browser's tab capture, so it is
// pixel-exact) with a header naming the page, URLs, viewport and date.
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var layer = $('annotations');
  var stage = $('stage');
  var panel = $('notesPanel');
  var openBtn = $('annotateBtn');
  var summary = $('summary');
  var dialog = $('shotDialog');
  var shotImg = $('shotImg');
  var toast = function (m) { window.SBS && window.SBS.toast(m); };

  var tool = 'scroll';
  var items = []; // { el, textarea }
  var stream = null;
  var video = null;
  var lastShot = null; // { blob, filename }

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
    scroll: 'Scroll to the spot, then pick <b>Callout</b> or <b>Box</b>. Drag a number to move it. Callouts stay put on screen, so take the screenshot before scrolling again.',
    pin: 'Click on the page where the problem is. <b>Esc</b> to go back to scrolling.',
    box: 'Drag on the page to outline an area. <b>Esc</b> to go back to scrolling.',
  };
  function setTool(t) {
    tool = t;
    layer.dataset.tool = t;
    panel.querySelectorAll('[data-tool]').forEach(function (b) { b.classList.toggle('active', b.dataset.tool === t); });
    $('toolHint').innerHTML = hints[t];
  }
  panel.querySelectorAll('[data-tool]').forEach(function (b) {
    b.addEventListener('click', function () { setTool(b.dataset.tool); });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && tool !== 'scroll' && !dialog.open) setTool('scroll');
  });

  // --- creating annotations ---------------------------------------------
  function localPoint(e) {
    var r = layer.getBoundingClientRect();
    return { x: Math.round(e.clientX - r.left), y: Math.round(e.clientY - r.top), w: r.width, h: r.height };
  }

  function place(el, x, y, w, h) {
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    var lw = layer.clientWidth, lh = layer.clientHeight;
    el.classList.toggle('flip-x', x + 260 > lw);
    el.classList.toggle('flip-y', y + (h || 0) + 120 > lh);
  }

  function addItem(kind, x, y, w, h) {
    var el = document.createElement('div');
    el.className = 'ann' + (kind === 'box' ? ' ann-box' : ' ann-pin');
    if (kind === 'box') { el.style.width = w + 'px'; el.style.height = h + 'px'; }
    el.innerHTML = '<span class="ann-num" title="Drag to move"></span>' +
      '<div class="ann-bubble empty"><textarea rows="1" placeholder="Comment…"></textarea>' +
      '<button type="button" class="ann-del" title="Delete">×</button></div>';
    layer.appendChild(el);
    place(el, x, y, w, h);

    var item = { el: el, kind: kind, textarea: el.querySelector('textarea') };
    items.push(item);
    renumber();

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
    makeDraggable(el, el.querySelector('.ann-num'), w, h);
    ta.focus();
  }

  function renumber() {
    items.forEach(function (it, i) { it.el.querySelector('.ann-num').textContent = i + 1; });
  }

  function makeDraggable(el, handle, w, h) {
    handle.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      var startX = e.clientX, startY = e.clientY;
      var ox = parseFloat(el.style.left), oy = parseFloat(el.style.top);
      function move(ev) { place(el, ox + ev.clientX - startX, oy + ev.clientY - startY, w, h); }
      function up() {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
      }
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  var draft = null;
  layer.addEventListener('pointerdown', function (e) {
    if (e.target !== layer || tool === 'scroll') return;
    e.preventDefault(); // keep focus in the new comment box
    var p = localPoint(e);
    if (tool === 'pin') { addItem('pin', p.x, p.y); return; }
    layer.setPointerCapture(e.pointerId);
    draft = { x: p.x, y: p.y, el: document.createElement('div') };
    draft.el.className = 'draft';
    layer.appendChild(draft.el);
  });
  layer.addEventListener('pointermove', function (e) {
    if (!draft) return;
    var p = localPoint(e);
    var x = Math.min(p.x, draft.x), y = Math.min(p.y, draft.y);
    Object.assign(draft.el.style, {
      left: x + 'px', top: y + 'px',
      width: Math.abs(p.x - draft.x) + 'px', height: Math.abs(p.y - draft.y) + 'px',
    });
  });
  layer.addEventListener('pointerup', function (e) {
    if (!draft) return;
    var p = localPoint(e);
    var x = Math.min(p.x, draft.x), y = Math.min(p.y, draft.y);
    var w = Math.abs(p.x - draft.x), h = Math.abs(p.y - draft.y);
    draft.el.remove();
    draft = null;
    if (w > 8 && h > 8) addItem('box', x, y, w, h);
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
    var notes = items.map(function (it, i) { return (i + 1) + '. ' + (it.textarea.value.trim() || '(no comment)'); });
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
