// Freestyle artboard: a blank page where blocks copied from the site (and new
// buttons, text, images and shapes) are free layers you can put anywhere,
// like in Figma: drag, snap, resize, reorder, duplicate, delete, edit text.
// Runs inside canvas.html; the Side by Side UI drives it via window.__sbsBoard.
(function () {
  'use strict';
  if (window.__sbsBoard) return;

  var doc = document;
  var board = doc.getElementById('sbs-board');
  var ACCENT = '#7c3aed';
  var SNAP = 6;

  // ------------------------------------------------------------------ state
  // layers: [{ id, k: 'block'|'button'|'text'|'image'|'shape', x, y, w, h|null,
  //            src (library path), v (text / html / image url), c (colour),
  //            ed: [{ p: [child indexes], h: html }] (text edits inside a block) }]
  // Array order is stacking order (last is on top).
  var layers = [];
  var undoStack = [];
  var redoStack = [];
  var selectedId = null;
  var nextId = 1;
  var source = function () { return null; }; // path -> element in the library
  var buttonPath = function () { return null; };
  var onChange = function () {};
  var placing = null; // { kind, text }
  var action = null;  // { type: 'move'|'resize'|'place', ... }
  var editing = null; // { id, el }
  var capturing = false;

  function snapshot() { return JSON.stringify(layers); }
  function commit(before) {
    if (before === snapshot()) return;
    undoStack.push(before);
    if (undoStack.length > 200) undoStack.shift();
    redoStack = [];
    render();
  }
  function find(id) { for (var i = 0; i < layers.length; i++) if (layers[i].id === id) return layers[i]; return null; }
  function indexOf(id) { for (var i = 0; i < layers.length; i++) if (layers[i].id === id) return i; return -1; }
  function newId() { var id = 'l' + nextId++; while (find(id)) id = 'l' + nextId++; return id; }

  // ---------------------------------------------------------- sanitizing text
  var ALLOWED = { B: 1, STRONG: 1, I: 1, EM: 1, U: 1, BR: 1, SPAN: 1, SMALL: 1, SUP: 1, SUB: 1, A: 1, P: 1, DIV: 1 };
  function cleanInto(src, out) {
    Array.prototype.forEach.call(src.childNodes, function (c) {
      if (c.nodeType === 3) { out.appendChild(doc.createTextNode(c.data)); return; }
      if (c.nodeType !== 1) return;
      if (!ALLOWED[c.tagName]) { cleanInto(c, out); return; }
      var e = doc.createElement(c.tagName);
      if (c.getAttribute('class')) e.setAttribute('class', c.getAttribute('class'));
      cleanInto(c, e);
      out.appendChild(e);
    });
  }
  function cleanHtml(html) {
    var parsed = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html'); // inert
    var div = doc.createElement('div');
    cleanInto(parsed.body.firstChild, div);
    return div.innerHTML;
  }
  function safeUrl(u) { return /^https?:\/\//i.test(u || '') || /^\/(?!\/)/.test(u || '') ? u : ''; }

  // ----------------------------------------------------- copying from the site
  // A copy of a library element, made safe and self-contained: absolute image
  // URLs, no scripts or handlers, wrapped in empty copies of its ancestors
  // (display: contents) so the site's CSS selectors still match it.
  function strip(el) {
    var all = [el].concat(Array.prototype.slice.call(el.querySelectorAll('*')));
    all.forEach(function (n) {
      if (/^(SCRIPT|NOSCRIPT|IFRAME|OBJECT|EMBED)$/.test(n.tagName)) { n.remove(); return; }
      Array.prototype.slice.call(n.attributes).forEach(function (a) {
        if (/^on/i.test(a.name) || /^\s*javascript:/i.test(a.value)) n.removeAttribute(a.name);
      });
      if (n.tagName === 'A') n.removeAttribute('target');
    });
  }
  function absolutize(copy, orig) {
    var a = [copy].concat(Array.prototype.slice.call(copy.querySelectorAll('img, source, video')));
    var b = [orig].concat(Array.prototype.slice.call(orig.querySelectorAll('img, source, video')));
    a.forEach(function (n, i) {
      var o = b[i];
      if (!o || o.tagName !== n.tagName) return;
      if (n.tagName === 'IMG') {
        var u = o.currentSrc || o.src;
        if (u) n.setAttribute('src', u);
        n.removeAttribute('srcset');
        n.removeAttribute('loading');
      } else if (n.tagName === 'SOURCE') {
        n.remove(); // the <img> fallback already has the chosen file
      } else if (n.tagName === 'VIDEO') {
        if (o.poster) n.setAttribute('poster', o.poster);
        if (o.currentSrc) n.setAttribute('src', o.currentSrc);
        n.muted = true;
      }
    });
  }
  function copyOf(path) {
    var orig = source(path);
    if (!orig) return null;
    var copy = doc.importNode(orig, true);
    absolutize(copy, orig);
    strip(copy);
    var outer = copy;
    for (var p = orig.parentElement; p && p.tagName !== 'BODY' && p.tagName !== 'HTML'; p = p.parentElement) {
      var shell = doc.importNode(p, false);
      strip(shell);
      shell.style.setProperty('display', 'contents', 'important');
      shell.appendChild(outer);
      outer = shell;
    }
    return { outer: outer, inner: copy };
  }
  function childAt(root, p) {
    var n = root;
    for (var i = 0; i < p.length && n; i++) n = n.children[p[i]];
    return n || null;
  }
  function pathIn(root, el) {
    var p = [];
    for (var n = el; n && n !== root; n = n.parentElement) p.unshift(Array.prototype.indexOf.call(n.parentElement.children, n));
    return p;
  }

  // ------------------------------------------------------------------ render
  var nodes = {}; // id -> { el, sig, inner }
  function contentSig(l) { return l.k + '|' + (l.src || '') + '|' + (l.v || '') + '|' + (l.c || '') + '|' + JSON.stringify(l.ed || []); }

  function build(l) {
    var wrap = doc.createElement('div');
    var inner = null;
    var outer = null;
    if (l.k === 'block') {
      var c = copyOf(l.src);
      if (c) { outer = c.outer; inner = c.inner; }
      else {
        inner = outer = doc.createElement('div');
        inner.className = 'sbs-img-ph';
        inner.textContent = 'Loading block…';
      }
    } else if (l.k === 'button') {
      var tp = l.src ? copyOf(l.src) : null;
      if (tp) { outer = tp.outer; inner = tp.inner; inner.textContent = l.v; }
      else {
        inner = outer = doc.createElement('a');
        inner.textContent = l.v;
        inner.style.cssText = 'display:inline-block;padding:12px 24px;border-radius:999px;background:' + ACCENT + ';color:#fff;font-weight:700;text-decoration:none;text-align:center;';
      }
      if (inner.tagName === 'A') inner.setAttribute('href', '#');
    } else if (l.k === 'text') {
      inner = outer = doc.createElement('div');
      inner.innerHTML = cleanHtml(l.v || '');
      inner.style.cssText = 'font-size:24px;line-height:1.3;white-space:pre-wrap;';
      if (l.c) inner.style.color = l.c;
    } else if (l.k === 'image') {
      var url = safeUrl(l.v);
      if (url) { inner = outer = doc.createElement('img'); inner.className = 'sbs-img'; inner.src = url; inner.alt = ''; }
      else { inner = outer = doc.createElement('div'); inner.className = 'sbs-img-ph'; inner.textContent = l.v || 'Image'; }
    } else {
      inner = outer = doc.createElement('div');
      inner.className = 'sbs-shape';
      inner.style.background = l.c || '#e9d5ff';
      inner.style.borderRadius = '12px';
    }
    inner.classList.add('sbs-content');
    (l.ed || []).forEach(function (e) {
      var t = childAt(inner, e.p);
      if (t) t.innerHTML = cleanHtml(e.h);
    });
    wrap.appendChild(outer);
    return { el: wrap, inner: inner };
  }

  function render() {
    if (editing && !find(editing.id)) editing = null;
    var keep = {};
    layers.forEach(function (l, i) {
      keep[l.id] = true;
      var sig = contentSig(l);
      var n = nodes[l.id];
      if (!n || n.sig !== sig) {
        if (n) n.el.remove();
        var b = build(l);
        n = nodes[l.id] = { el: b.el, inner: b.inner, sig: sig };
        n.el.dataset.id = l.id;
      }
      var el = n.el;
      el.className = 'sbs-layer' + (l.h ? ' fill-h' : '');
      el.style.left = l.x + 'px';
      el.style.top = l.y + 'px';
      el.style.width = l.w + 'px';
      el.style.height = l.h ? l.h + 'px' : '';
      el.style.zIndex = String(i + 1);
      if (el.parentNode !== board || board.children[i] !== el) board.insertBefore(el, board.children[i] || null);
    });
    Object.keys(nodes).forEach(function (id) {
      if (!keep[id]) { nodes[id].el.remove(); delete nodes[id]; }
    });
    if (selectedId && !find(selectedId)) selectedId = null;
    board.classList.toggle('empty', !layers.length);
    grow();
    position();
    notify();
  }

  function grow() {
    var bottom = 0;
    layers.forEach(function (l) {
      var n = nodes[l.id];
      bottom = Math.max(bottom, l.y + (n ? n.el.offsetHeight : 0));
    });
    board.style.height = Math.max(window.innerHeight, bottom + 300) + 'px';
  }

  function describe(l) {
    if (!l) return null;
    var names = { block: 'block', button: 'button', text: 'text', image: 'image', shape: 'shape' };
    var txt = '';
    var n = nodes[l.id];
    if (n && l.k !== 'shape' && l.k !== 'image') txt = (n.inner.textContent || '').replace(/\s+/g, ' ').trim();
    return names[l.k] + (txt ? ' “' + txt.slice(0, 24) + (txt.length > 24 ? '…' : '') + '”' : '');
  }

  function notify() {
    var l = find(selectedId);
    onChange({
      count: layers.length,
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0,
      selected: describe(l),
      selectedKind: l ? l.k : null,
      selectedColor: l ? l.c || null : null,
      placing: placing ? placing.kind : null,
    });
  }

  // ----------------------------------------------------------------- overlay
  var host = doc.createElement('div');
  host.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;';
  var shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML =
    '<style>' +
    '.box{position:absolute;pointer-events:none;box-sizing:border-box}' +
    '.hover{outline:1px solid ' + ACCENT + '99}' +
    '.sel{outline:2px solid ' + ACCENT + '}' +
    '.h{position:absolute;width:10px;height:10px;margin:-6px 0 0 -6px;background:#fff;border:2px solid ' + ACCENT + ';border-radius:2px;pointer-events:auto;box-sizing:border-box}' +
    '.guide{position:absolute;background:#f43f5e;pointer-events:none}' +
    '.size{position:absolute;transform:translate(-50%,6px);background:' + ACCENT + ';color:#fff;font:600 11px system-ui,sans-serif;padding:2px 6px;border-radius:4px;white-space:nowrap;pointer-events:none}' +
    '.rect{position:absolute;border:1px dashed ' + ACCENT + ';background:' + ACCENT + '14;pointer-events:none}' +
    '</style>' +
    '<div class="box hover" hidden></div><div class="box sel" hidden></div><div class="guides"></div>' +
    '<div class="size" hidden></div><div class="rect" hidden></div>';
  var hoverBox = shadow.querySelector('.hover');
  var selBox = shadow.querySelector('.sel');
  var guidesEl = shadow.querySelector('.guides');
  var sizeTag = shadow.querySelector('.size');
  var rectEl = shadow.querySelector('.rect');
  var HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  var CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };
  var handles = {};
  HANDLES.forEach(function (d) {
    var h = doc.createElement('div');
    h.className = 'h';
    h.dataset.dir = d;
    h.style.cursor = CURSORS[d];
    h.hidden = true;
    shadow.appendChild(h);
    handles[d] = h;
  });
  board.appendChild(host);

  function rectOf(l) {
    var n = nodes[l.id];
    return { x: l.x, y: l.y, w: l.w, h: l.h || (n ? n.el.offsetHeight : 0) };
  }
  function show(box, r) {
    box.hidden = !r;
    if (!r) return;
    box.style.left = r.x + 'px';
    box.style.top = r.y + 'px';
    box.style.width = r.w + 'px';
    box.style.height = r.h + 'px';
  }
  function position() {
    if (host.parentNode !== board || board.lastElementChild !== host) board.appendChild(host);
    var l = find(selectedId);
    var r = l && !capturing ? rectOf(l) : null;
    show(selBox, r);
    HANDLES.forEach(function (d) {
      var h = handles[d];
      h.hidden = !r || !!editing;
      if (h.hidden) return;
      var x = d.indexOf('w') >= 0 ? r.x : d.indexOf('e') >= 0 ? r.x + r.w : r.x + r.w / 2;
      var y = d.indexOf('n') >= 0 ? r.y : d.indexOf('s') >= 0 ? r.y + r.h : r.y + r.h / 2;
      h.style.left = x + 'px';
      h.style.top = y + 'px';
    });
    if (capturing) { hoverBox.hidden = true; sizeTag.hidden = true; }
  }
  function setHover(l) { show(hoverBox, l && l.id !== selectedId && !action && !capturing ? rectOf(l) : null); }
  function select(id) { selectedId = id; position(); notify(); }

  // -------------------------------------------------------------- snapping
  // Snap a moving box's edges and centre to other layers and to the board's
  // centre. Returns the adjusted position and the guide lines to draw.
  function snapMove(id, x, y, w, h) {
    var xs = [{ v: board.clientWidth / 2, k: 'c' }], ys = [];
    layers.forEach(function (o) {
      if (o.id === id) return;
      var r = rectOf(o);
      xs.push({ v: r.x }, { v: r.x + r.w / 2 }, { v: r.x + r.w });
      ys.push({ v: r.y }, { v: r.y + r.h / 2 }, { v: r.y + r.h });
    });
    var bx = best([x, x + w / 2, x + w], xs);
    var by = best([y, y + h / 2, y + h], ys);
    var guides = [];
    if (bx) { x += bx.d; guides.push({ x: bx.v }); }
    if (by) { y += by.d; guides.push({ y: by.v }); }
    return { x: x, y: y, guides: guides };
  }
  function best(mine, targets) {
    var out = null;
    mine.forEach(function (m) {
      targets.forEach(function (t) {
        var d = t.v - m;
        if (Math.abs(d) <= SNAP && (!out || Math.abs(d) < Math.abs(out.d))) out = { d: d, v: t.v };
      });
    });
    return out;
  }
  function drawGuides(list) {
    guidesEl.innerHTML = '';
    (list || []).forEach(function (g) {
      var d = doc.createElement('div');
      d.className = 'guide';
      if (g.x != null) d.style.cssText = 'left:' + g.x + 'px;top:0;width:1px;height:' + board.offsetHeight + 'px';
      else d.style.cssText = 'top:' + g.y + 'px;left:0;height:1px;width:' + board.clientWidth + 'px';
      guidesEl.appendChild(d);
    });
  }
  function showSize(r) {
    sizeTag.hidden = !r;
    if (!r) return;
    sizeTag.textContent = Math.round(r.w) + ' × ' + Math.round(r.h);
    sizeTag.style.left = (r.x + r.w / 2) + 'px';
    sizeTag.style.top = (r.y + r.h) + 'px';
  }

  // ------------------------------------------------------------------ events
  function pt(e) {
    var b = board.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  }
  function layerAt(t) {
    var el = t && t.closest ? t.closest('.sbs-layer') : null;
    return el && el.parentNode === board ? find(el.dataset.id) : null;
  }
  function inEdit(t) { return editing && t && editing.el.contains(t); }

  function onDown(e) {
    if (e.button !== 0) return;
    window.focus();
    var path = e.composedPath ? e.composedPath() : [];
    var handle = path[0] && path[0].dataset && path[0].dataset.dir && path[0].getRootNode() === shadow ? path[0].dataset.dir : null;
    if (inEdit(e.target)) return; // typing / selecting text
    if (editing) endEdit();
    e.preventDefault();
    var p = pt(e);
    if (placing) {
      action = { type: 'place', x0: p.x, y0: p.y };
      return;
    }
    if (handle && selectedId) {
      var l0 = find(selectedId);
      var r0 = rectOf(l0);
      action = { type: 'resize', id: l0.id, dir: handle, start: p, r: r0, before: snapshot(), keepH: l0.h != null, ratio: r0.w / Math.max(1, r0.h) };
      return;
    }
    var l = layerAt(e.target);
    if (!l) { select(null); return; }
    if (l.id !== selectedId) select(l.id);
    action = { type: 'move', id: l.id, start: p, x: l.x, y: l.y, before: snapshot(), moved: false };
    hoverBox.hidden = true;
  }

  function onMove(e) {
    var p = pt(e);
    if (!action) {
      if (!placing && !editing) setHover(layerAt(e.target));
      return;
    }
    autoScroll(e);
    var l;
    if (action.type === 'move') {
      l = find(action.id);
      var dx = p.x - action.start.x, dy = p.y - action.start.y;
      if (!action.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      action.moved = true;
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      var r = rectOf(l);
      var s = e.altKey ? { x: action.x + dx, y: action.y + dy, guides: [] } : snapMove(l.id, action.x + dx, action.y + dy, r.w, r.h);
      l.x = Math.round(s.x);
      l.y = Math.max(0, Math.round(s.y));
      nodes[l.id].el.style.left = l.x + 'px';
      nodes[l.id].el.style.top = l.y + 'px';
      drawGuides(s.guides);
      position();
      showSize(null);
    } else if (action.type === 'resize') {
      l = find(action.id);
      var a = action, d = a.dir;
      var x = a.r.x, y = a.r.y, w = a.r.w, h = a.r.h;
      var mx = p.x - a.start.x, my = p.y - a.start.y;
      if (d.indexOf('e') >= 0) w = a.r.w + mx;
      if (d.indexOf('w') >= 0) { w = a.r.w - mx; x = a.r.x + mx; }
      if (d.indexOf('s') >= 0) h = a.r.h + my;
      if (d.indexOf('n') >= 0) { h = a.r.h - my; y = a.r.y + my; }
      // Shift (or any image) keeps the proportions on a corner handle.
      if ((e.shiftKey || l.k === 'image') && d.length === 2) {
        h = w / a.ratio;
        if (d.indexOf('n') >= 0) y = a.r.y + a.r.h - h;
      }
      if (w < 16) { if (d.indexOf('w') >= 0) x -= 16 - w; w = 16; }
      if (h < 8) { if (d.indexOf('n') >= 0) y -= 8 - h; h = 8; }
      l.x = Math.round(x);
      l.y = Math.max(0, Math.round(y));
      l.w = Math.round(w);
      // Blocks keep their natural height unless a top/bottom handle is used.
      if (a.keepH || d.indexOf('n') >= 0 || d.indexOf('s') >= 0) l.h = Math.round(h);
      var el = nodes[l.id].el;
      el.style.left = l.x + 'px';
      el.style.top = l.y + 'px';
      el.style.width = l.w + 'px';
      el.style.height = l.h ? l.h + 'px' : '';
      el.classList.toggle('fill-h', !!l.h);
      position();
      showSize(rectOf(l));
    } else if (action.type === 'place') {
      var rx = Math.min(action.x0, p.x), ry = Math.min(action.y0, p.y);
      show(rectEl, { x: rx, y: ry, w: Math.abs(p.x - action.x0), h: Math.abs(p.y - action.y0) });
    }
  }

  function onUp(e) {
    if (!action) return;
    var a = action;
    action = null;
    drawGuides(null);
    showSize(null);
    rectEl.hidden = true;
    if (a.type === 'place') {
      var p = pt(e);
      var w = Math.abs(p.x - a.x0), h = Math.abs(p.y - a.y0);
      var drawn = w > 8 && h > 8;
      addPrimitive(placing.kind, placing.text, Math.min(a.x0, p.x), Math.min(a.y0, p.y), drawn ? w : null, drawn ? h : null);
      placing = null;
      doc.documentElement.style.cursor = '';
      notify();
      return;
    }
    commit(a.before);
  }

  var scrollTimer = null;
  function autoScroll(e) {
    var edge = 50;
    var dy = e.clientY > window.innerHeight - edge ? 14 : e.clientY < edge ? -14 : 0;
    if (dy) {
      if (dy > 0) board.style.height = Math.max(board.offsetHeight, window.scrollY + window.innerHeight + 200) + 'px';
      window.scrollBy(0, dy);
    }
  }

  function onDbl(e) {
    var l = layerAt(e.target);
    if (!l || l.k === 'shape' || l.k === 'image') return;
    e.preventDefault();
    startEdit(l, e.target);
  }

  function startEdit(l, target) {
    var n = nodes[l.id];
    var el = n.inner;
    if (l.k === 'block' && target && n.inner.contains(target)) {
      // The text element under the mouse, not the whole block.
      el = target;
      while (el !== n.inner && !hasOwnText(el)) el = el.parentElement;
      if (!hasOwnText(el)) { el = target.closest('p,h1,h2,h3,h4,h5,h6,li,a,button,span,label,div') || n.inner; }
      if (!n.inner.contains(el)) el = n.inner;
    }
    editing = { id: l.id, el: el, before: snapshot(), html: el.innerHTML };
    el.setAttribute('contenteditable', 'true');
    el.focus();
    var range = doc.createRange();
    range.selectNodeContents(el);
    var s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
    select(l.id);
    position();
  }
  function hasOwnText(el) {
    return Array.prototype.some.call(el.childNodes, function (c) { return c.nodeType === 3 && c.data.trim(); });
  }
  function endEdit() {
    if (!editing) return;
    var ed = editing;
    editing = null;
    ed.el.removeAttribute('contenteditable');
    var l = find(ed.id);
    var html = cleanHtml(ed.el.innerHTML);
    if (!l || ed.el.innerHTML === ed.html) { position(); return; }
    var n = nodes[l.id];
    if (l.k === 'text') l.v = html;
    else if (l.k === 'button') l.v = (ed.el.textContent || '').trim() || l.v;
    else {
      var p = pathIn(n.inner, ed.el);
      l.ed = (l.ed || []).filter(function (x) { return x.p.join() !== p.join(); });
      l.ed.push({ p: p, h: html });
    }
    commit(ed.before);
  }

  function onClick(e) {
    // Links and buttons in the copies never navigate or submit.
    if (inEdit(e.target)) { if (e.target.closest('a')) e.preventDefault(); return; }
    e.preventDefault();
  }
  function onSubmit(e) { e.preventDefault(); }

  function onKey(e) {
    if (editing) {
      if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey && editing && find(editing.id).k !== 'block')) { e.preventDefault(); endEdit(); }
      return;
    }
    var mod = e.ctrlKey || e.metaKey;
    var k = e.key;
    if (k === 'Escape') { if (placing) api.cancelPlace(); else select(null); return; }
    if (mod && k.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) api.redo(); else api.undo(); return; }
    if (mod && k.toLowerCase() === 'y') { e.preventDefault(); api.redo(); return; }
    if (!selectedId) return;
    if (mod && k.toLowerCase() === 'd') { e.preventDefault(); api.duplicate(); return; }
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); api.remove(); return; }
    if (k === ']') { e.preventDefault(); api.forward(mod); return; }
    if (k === '[') { e.preventDefault(); api.backward(mod); return; }
    if (k === 'Enter') { e.preventDefault(); var l = find(selectedId); if (l.k !== 'shape' && l.k !== 'image') startEdit(l, null); return; }
    var arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[k]) {
      e.preventDefault();
      var step = e.shiftKey ? 10 : 1;
      var before = snapshot();
      var lay = find(selectedId);
      lay.x += arrows[k][0] * step;
      lay.y = Math.max(0, lay.y + arrows[k][1] * step);
      commit(before);
    }
  }

  doc.addEventListener('mousedown', onDown, true);
  doc.addEventListener('mousemove', onMove, true);
  doc.addEventListener('mouseup', onUp, true);
  doc.addEventListener('dblclick', onDbl, true);
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('submit', onSubmit, true);
  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('dragstart', function (e) { e.preventDefault(); }, true);
  doc.addEventListener('focusout', function (e) { if (editing && e.target === editing.el) endEdit(); }, true);
  window.addEventListener('resize', function () { grow(); position(); });

  // -------------------------------------------------------------- adding
  function addLayer(l) {
    var before = snapshot();
    l.id = newId();
    layers.push(l);
    selectedId = l.id;
    commit(before);
    return l;
  }
  function addPrimitive(kind, text, x, y, w, h) {
    var l = { k: kind, x: Math.round(x), y: Math.round(y) };
    if (kind === 'button') {
      l.src = buttonPath() || undefined;
      l.v = text || 'Button';
      l.w = Math.round(w || 200);
      if (h) l.h = Math.round(h);
    } else if (kind === 'text') {
      l.v = cleanHtml((text || 'New text').replace(/</g, '&lt;'));
      l.w = Math.round(w || 320);
      if (h) l.h = Math.round(h);
    } else if (kind === 'image') {
      l.v = text || 'Image';
      l.w = Math.round(w || 320);
      l.h = Math.round(h || 220);
    } else {
      l.k = 'shape';
      l.c = '#e9d5ff';
      l.w = Math.round(w || 240);
      l.h = Math.round(h || 160);
    }
    // A button sized by click alone takes the width of its own text.
    var added = addLayer(l);
    if (kind === 'button' && !w) {
      var n = nodes[added.id];
      var inner = n.inner;
      n.el.style.width = 'max-content';
      inner.style.setProperty('width', 'auto', 'important');
      var nat = Math.ceil(n.el.getBoundingClientRect().width);
      inner.style.removeProperty('width');
      added.w = Math.max(60, Math.min(nat, board.clientWidth));
      render();
    }
  }

  // --------------------------------------------------------------------- API
  var api = {
    start: function (opts) {
      opts = opts || {};
      source = opts.source || source;
      buttonPath = opts.buttonPath || buttonPath;
      onChange = opts.onChange || onChange;
      if (opts.layers) {
        layers = JSON.parse(JSON.stringify(opts.layers));
        undoStack = [];
        redoStack = [];
        selectedId = null;
      }
      render();
    },
    /** Copy the site's stylesheets and page classes so copied blocks look the same. */
    adoptStyles: function (srcDoc) {
      Array.prototype.forEach.call(doc.querySelectorAll('[data-sbs-adopted]'), function (n) { n.remove(); });
      var head = doc.head;
      var base = doc.getElementById('sbs-board-base');
      Array.prototype.forEach.call(srcDoc.querySelectorAll('link[rel~="stylesheet"], style'), function (s) {
        var n;
        if (s.tagName === 'LINK') {
          if (!s.href) return;
          n = doc.createElement('link');
          n.rel = 'stylesheet';
          n.href = s.href;
          if (s.media) n.media = s.media;
        } else {
          var css = '';
          try { css = Array.prototype.map.call(s.sheet.cssRules, function (r) { return r.cssText; }).join('\n'); }
          catch (e) { css = s.textContent; }
          n = doc.createElement('style');
          n.textContent = css;
        }
        n.setAttribute('data-sbs-adopted', '');
        head.insertBefore(n, base); // ours stays last, so it wins
      });
      ['class', 'style', 'lang', 'dir'].forEach(function (a) {
        var v = srcDoc.documentElement.getAttribute(a);
        if (v != null) doc.documentElement.setAttribute(a, v); else if (a !== 'lang') doc.documentElement.removeAttribute(a);
      });
      Array.prototype.forEach.call(srcDoc.documentElement.attributes, function (a) {
        if (/^data-/.test(a.name)) doc.documentElement.setAttribute(a.name, a.value);
      });
      var bc = srcDoc.body.getAttribute('class');
      if (bc) doc.body.setAttribute('class', bc);
      Array.prototype.forEach.call(srcDoc.body.attributes, function (a) {
        if (/^data-/.test(a.name)) doc.body.setAttribute(a.name, a.value);
      });
      // Blocks waiting for the library get built now.
      nodes = (function () { Object.keys(nodes).forEach(function (id) { nodes[id].el.remove(); }); return {}; })();
      render();
      setTimeout(function () { grow(); position(); }, 600); // after fonts and images settle
    },
    /** A block dropped from the library at (x, y) in this window; (dx, dy) is where it was held. */
    drop: function (path, x, y, dx, dy, w) {
      var b = board.getBoundingClientRect();
      w = Math.round(Math.min(w, board.clientWidth));
      // Keep it on the artboard: a wide block dropped near the edge slides in.
      var lx = Math.max(0, Math.min(Math.round(x - b.left - (dx || 0)), board.clientWidth - w));
      addLayer({ k: 'block', src: path, x: lx, y: Math.max(0, Math.round(y - b.top - (dy || 0))), w: w });
    },
    /** Add a block at the top of the visible area (when dragging isn't handy). */
    addBlock: function (path, w) {
      var b = board.getBoundingClientRect();
      var y = Math.max(0, -b.top + 40);
      var x = Math.max(0, Math.round((board.clientWidth - w) / 2));
      addLayer({ k: 'block', src: path, x: x, y: Math.round(y), w: Math.round(Math.min(w, board.clientWidth)) });
    },
    /** Next click (or drag, to set the size) on the board adds this kind of layer. */
    place: function (kind, text) {
      if (editing) endEdit();
      placing = { kind: kind, text: text };
      doc.documentElement.style.cursor = 'crosshair';
      select(null);
    },
    cancelPlace: function () {
      if (!placing) return;
      placing = null;
      action = null;
      rectEl.hidden = true;
      doc.documentElement.style.cursor = '';
      notify();
    },
    undo: function () {
      if (editing) endEdit();
      if (!undoStack.length) return;
      redoStack.push(snapshot());
      layers = JSON.parse(undoStack.pop());
      render();
    },
    redo: function () {
      if (!redoStack.length) return;
      undoStack.push(snapshot());
      layers = JSON.parse(redoStack.pop());
      render();
    },
    reset: function () { var b = snapshot(); layers = []; selectedId = null; commit(b); },
    duplicate: function () {
      var l = find(selectedId);
      if (!l) return;
      var c = JSON.parse(JSON.stringify(l));
      c.x += 20;
      c.y += 20;
      var before = snapshot();
      c.id = newId();
      layers.splice(indexOf(l.id) + 1, 0, c);
      selectedId = c.id;
      commit(before);
    },
    remove: function () {
      if (!selectedId) return;
      var before = snapshot();
      layers.splice(indexOf(selectedId), 1);
      selectedId = null;
      commit(before);
    },
    forward: function (toFront) {
      var i = indexOf(selectedId);
      if (i < 0 || i === layers.length - 1) return;
      var before = snapshot();
      var l = layers.splice(i, 1)[0];
      layers.splice(toFront ? layers.length : i + 1, 0, l);
      commit(before);
    },
    backward: function (toBack) {
      var i = indexOf(selectedId);
      if (i <= 0) return;
      var before = snapshot();
      var l = layers.splice(i, 1)[0];
      layers.splice(toBack ? 0 : i - 1, 0, l);
      commit(before);
    },
    setColor: function (c) {
      var l = find(selectedId);
      if (!l || !/^#[0-9a-f]{3,8}$/i.test(c)) return;
      var before = snapshot();
      l.c = c;
      commit(before);
    },
    setCapturing: function (on) { capturing = on; host.style.visibility = on ? 'hidden' : ''; position(); },
    save: function () { return JSON.parse(snapshot()); },
    count: function () { return layers.length; },
  };
  window.__sbsBoard = api;
})();
