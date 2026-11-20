// Freestyle: mock up changes to a page. Two modes:
// - "Edit this page": the live pane becomes an editable copy of the page
//   (freestyle-editor.js runs inside it).
// - "Blank artboard": the live pane is a library of the site's blocks, and the
//   other pane is a blank artboard (canvas.html + freestyle-artboard.js) where
//   dragged blocks, buttons, text, images and shapes go anywhere, like Figma.
// This file is the panel, the layout, dragging between the two frames,
// screenshots and share links.
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var btn = $('freestyleBtn');
  var panel = $('fsPanel');
  var notesPanel = $('notesPanel');
  var toast = function (m) { window.SBS && window.SBS.toast(m); };
  var liveFrame = function () { return document.querySelector('.pane[data-role="live"] iframe'); };
  var boardFrame = function () { return document.querySelector('.pane[data-role="staging"] iframe'); };

  var on = false;
  var mode = 'edit'; // 'edit' | 'artboard'
  var ops = [];      // edits to the page (both modes: the library shows the edited page)
  var layers = [];   // artboard layers
  var editor = null; // in the live frame
  var board = null;  // in the artboard frame
  var info = {};
  var boardInfo = {};

  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }

  function setInfo() {
    var art = mode === 'artboard';
    var i = art ? boardInfo : info;
    var sel = i.selected;
    $('fsSel').textContent = sel ? 'Selected: ' + sel : (art && info.selected ? 'In the site: ' + info.selected : 'Nothing selected');
    $('fsSel').classList.toggle('on', !!sel);
    var n = art ? (i.count || 0) : ops.length;
    $('fsCount').textContent = art ? (n ? plural(n, 'layer') + ' on the artboard' : 'The artboard is empty')
      : (n ? plural(n, 'change') : 'No changes yet');
    $('fsUndo').disabled = !i.canUndo;
    $('fsRedo').disabled = !i.canRedo;
    $('fsReset').disabled = !n;
    panel.querySelectorAll('[data-add]').forEach(function (b) {
      b.classList.toggle('active', i.placing === b.dataset.add);
    });
    panel.querySelectorAll('[data-arrange]').forEach(function (b) { b.disabled = !sel; });
    var colorable = i.selectedKind === 'shape' || i.selectedKind === 'text';
    $('fsColor').disabled = !colorable;
    if (colorable && i.selectedColor) $('fsColor').value = i.selectedColor;
    $('fsAddSel').disabled = !info.selectedPath;
  }

  function setMode(m) {
    mode = m === 'artboard' ? 'artboard' : 'edit';
    panel.dataset.mode = mode;
    panel.querySelectorAll('[data-fs-mode]').forEach(function (b) {
      b.classList.toggle('active', b.dataset.fsMode === mode);
      b.setAttribute('aria-pressed', String(b.dataset.fsMode === mode));
    });
    panel.querySelectorAll('[data-only]').forEach(function (el) { el.hidden = el.dataset.only !== mode; });
  }

  // ------------------------------------------------------------- the page
  // Load the editor into the page once it has finished loading and settled
  // (Nuxt/Vue hydration), then start it with the current edits.
  var waiting = null;
  function attach() {
    var frame = liveFrame();
    if (waiting) frame.removeEventListener('load', waiting);
    waiting = function () {
      waiting = null;
      setTimeout(function () { inject(frame); }, 900);
    };
    var doc = null;
    try { doc = frame.contentDocument; } catch (e) { doc = null; }
    if (doc && doc.readyState === 'complete' && frame.contentWindow.__sbsAgent) { var w = waiting; waiting = null; w(); }
    else frame.addEventListener('load', waiting, { once: true });
  }
  function startEditor() {
    if (!editor) return;
    editor.start({
      ops: ops,
      mode: mode === 'artboard' ? 'library' : 'edit',
      onChange: function (list, i) { ops = list; info = i; setInfo(); },
      onExternal: onExternal,
    });
    if (mode === 'artboard') linkBoard();
  }
  function inject(frame) {
    if (!on) return;
    var w = frame.contentWindow;
    var start = function () { editor = w.__sbsFS; startEditor(); };
    if (w.__sbsFS) { start(); return; }
    var s = w.document.createElement('script');
    s.src = '/__sbs/ui/freestyle-editor.js';
    s.onload = start;
    s.onerror = function () { toast('Couldn’t start Freestyle on this page'); };
    (w.document.head || w.document.documentElement).appendChild(s);
  }

  // If the page reloads while editing (device switch, reload button), re-attach.
  liveFrame().addEventListener('load', function () {
    if (on) { editor = null; attach(); }
  });

  // ------------------------------------------------------------ the artboard
  // Called whenever either frame (re)loads; starts the board once both are ready.
  function linkBoard() {
    if (!on || mode !== 'artboard') return;
    var f = boardFrame();
    var w = f.contentWindow;
    board = w && w.__sbsBoard ? w.__sbsBoard : null;
    if (!board) return; // its load event calls back here
    board.start({
      layers: layers,
      source: function (p) { return editor ? editor.elementAt(p) : null; },
      buttonPath: function () { return editor ? editor.buttonPath() : null; },
      onChange: function (i) { boardInfo = i; layers = board.save(); setInfo(); },
    });
    if (editor) {
      try { board.adoptStyles(liveFrame().contentDocument); } catch (e) { /* page went away */ }
    }
  }
  boardFrame().addEventListener('load', function () {
    board = null;
    if (on && mode === 'artboard') linkBoard();
  });

  // Dragging a block out of the site onto the artboard. The page reports the
  // drag in its own coordinates; a ghost follows the mouse up here. A cover
  // over the whole app catches the mouse if the page loses it.
  var drag = null;
  var ghost = document.createElement('div');
  ghost.className = 'fs-ghost';
  ghost.hidden = true;
  var cover = document.createElement('div');
  cover.className = 'fs-cover';
  cover.hidden = true;
  document.body.appendChild(cover);
  document.body.appendChild(ghost);

  function frameScale(frame) {
    var r = frame.getBoundingClientRect();
    return { r: r, s: frame.offsetWidth ? r.width / frame.offsetWidth : 1 };
  }
  function overBoard(x, y) {
    var f = boardFrame();
    var g = frameScale(f);
    var r = g.r;
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
    return { x: (x - r.left) / g.s, y: (y - r.top) / g.s };
  }
  function moveGhost(x, y) {
    var s = frameScale(liveFrame()).s;
    ghost.style.transform = 'translate(' + (x - drag.dx * s) + 'px,' + (y - drag.dy * s) + 'px)';
    ghost.style.width = (drag.w * s) + 'px';
    ghost.style.height = Math.min(drag.h * s, 400) + 'px';
    ghost.classList.toggle('ok', !!overBoard(x, y));
  }
  function fromLibrary(m) {
    var g = frameScale(liveFrame());
    return { x: g.r.left + m.x * g.s, y: g.r.top + m.y * g.s };
  }
  function onExternal(m) {
    if (m.phase === 'start') {
      drag = m;
      ghost.textContent = m.label;
      ghost.hidden = false;
      cover.hidden = false;
      var p = fromLibrary(m);
      moveGhost(p.x, p.y);
    } else if (!drag) {
      return;
    } else if (m.phase === 'move') {
      var q = fromLibrary(m);
      moveGhost(q.x, q.y);
    } else {
      var e = m.phase === 'end' ? fromLibrary(m) : null;
      finishDrag(e);
    }
  }
  function finishDrag(at) {
    var d = drag;
    drag = null;
    if (editor && editor.endExternal) editor.endExternal();
    ghost.hidden = true;
    cover.hidden = true;
    if (!d || !at) return;
    var b = overBoard(at.x, at.y);
    if (!b) return;
    if (!board) { toast('The artboard is still loading'); return; }
    board.drop(d.path, b.x, b.y, d.dx, d.dy, d.w);
    try { boardFrame().contentWindow.focus(); } catch (e) { /* ignore */ }
  }
  cover.addEventListener('mousemove', function (e) { if (drag) moveGhost(e.clientX, e.clientY); });
  cover.addEventListener('mouseup', function (e) { if (drag) finishDrag({ x: e.clientX, y: e.clientY }); });

  // --------------------------------------------------------------- open/close
  function open(data) {
    if (!window.SBS.ensureLive()) { toast('Enter a website in Live first'); return; }
    if (!notesPanel.hidden) $('annotateClose').click();
    on = true;
    ops = (data && data.ops) || ops || [];
    layers = (data && data.board) || layers || [];
    setMode(data && data.mode);
    document.body.classList.add('freestyle-on');
    btn.setAttribute('aria-pressed', 'true');
    panel.hidden = false;
    $('fsOriginal').checked = false;
    applyLayout();
    setInfo();
    attach();
  }
  function applyLayout() {
    window.SBS.freestyleLayout(true, mode === 'edit' && $('fsOriginal').checked, mode === 'artboard');
  }

  function changeCount() { return ops.length + layers.length; }
  function close() {
    var n = changeCount();
    if (n && !confirm('Leave Freestyle? Your mockup will be lost unless you copied the link.')) return;
    on = false;
    if (editor) { try { editor.stop(); } catch (e) { /* page may have gone */ } }
    editor = null;
    board = null;
    ops = [];
    layers = [];
    info = {};
    boardInfo = {};
    document.body.classList.remove('freestyle-on');
    btn.setAttribute('aria-pressed', 'false');
    panel.hidden = true;
    window.SBS.freestyleLayout(false);
  }

  btn.addEventListener('click', function () { if (on) close(); else open(null); });
  $('fsClose').addEventListener('click', close);

  panel.querySelectorAll('[data-fs-mode]').forEach(function (b) {
    b.addEventListener('click', function () {
      if (!on || b.dataset.fsMode === mode) return;
      if (editor) editor.cancelPlace();
      if (board) board.cancelPlace();
      setMode(b.dataset.fsMode);
      applyLayout();
      startEditor();
      setInfo();
    });
  });

  panel.querySelectorAll('[data-add]').forEach(function (b) {
    b.addEventListener('click', function () {
      var text = $('fsText').value.trim();
      var kind = b.dataset.add;
      var t = kind === 'image' ? (text || 'Image') : kind === 'shape' ? '' : (text || (kind === 'button' ? 'Button' : 'New text'));
      // Then click (or drag, on the artboard) where it should go.
      if (mode === 'artboard') { if (board) board.place(kind, t); }
      else if (editor) editor.place(kind, t);
    });
  });
  // Esc cancels placing even when the keyboard focus is here in the panel.
  document.addEventListener('keydown', function (e) {
    if (!on || e.key !== 'Escape') return;
    if (drag) finishDrag(null);
    if (editor) editor.cancelPlace();
    if (board) board.cancelPlace();
  });
  function target() { return mode === 'artboard' ? board : editor; }
  $('fsUndo').addEventListener('click', function () { var t = target(); if (t) t.undo(); });
  $('fsRedo').addEventListener('click', function () { var t = target(); if (t) t.redo(); });
  $('fsReset').addEventListener('click', function () {
    var t = target();
    if (!t) return;
    var msg = mode === 'artboard' ? 'Remove everything from the artboard?' : 'Undo all ' + plural(ops.length, 'change') + '?';
    if (confirm(msg)) t.reset();
  });
  $('fsOriginal').addEventListener('change', applyLayout);

  panel.querySelectorAll('[data-arrange]').forEach(function (b) {
    b.addEventListener('click', function () {
      if (!board) return;
      var a = b.dataset.arrange;
      if (a === 'front') board.forward(true);
      else if (a === 'back') board.backward(true);
      else if (a === 'dup') board.duplicate();
      else if (a === 'del') board.remove();
    });
  });
  $('fsColor').addEventListener('input', function () { if (board) board.setColor($('fsColor').value); });
  $('fsAddSel').addEventListener('click', function () {
    if (!board || !editor || !info.selectedPath) return;
    var el = editor.elementAt(info.selectedPath);
    board.addBlock(info.selectedPath, el ? el.getBoundingClientRect().width : 600);
  });

  // Screenshots reuse the Annotate capture; hide the editors' outlines meanwhile.
  window.addEventListener('sbs:capture-start', function () {
    if (editor) editor.setCapturing(true);
    if (board) board.setCapturing(true);
  });
  window.addEventListener('sbs:capture-end', function () {
    if (editor) editor.setCapturing(false);
    if (board) board.setCapturing(false);
  });
  $('fsShot').addEventListener('click', function () { $('captureBtn').click(); });

  $('fsLink').addEventListener('click', function () {
    window.SBS.shareUrl().then(function (url) {
      return navigator.clipboard.writeText(url).then(function () {
        var n = mode === 'artboard' ? layers.length : ops.length;
        toast(n ? 'Link copied with ' + plural(n, mode === 'artboard' ? 'layer' : 'change') : 'Link copied');
      });
    }).catch(function () { toast('Couldn’t copy the link'); });
  });

  setMode('edit');

  window.SBS = window.SBS || {};
  window.SBS.freestyle = {
    save: function () {
      if (!on) return null;
      var d = { v: 1, ops: ops };
      if (mode === 'artboard') { d.mode = 'artboard'; d.board = layers; }
      return d;
    },
    open: function (data) { if (data && data.v === 1) open(data); },
    isOn: function () { return on; },
  };
})();
