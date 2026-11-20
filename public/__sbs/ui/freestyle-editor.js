// Freestyle editor. Runs inside the proxied page (loaded on demand by the
// Side by Side UI) and turns it into an editable canvas: select, move, drag,
// duplicate, delete, edit text and add elements.
//
// When it starts it takes a snapshot of the fully rendered page and edits
// that, so the site's own code can't re-render the edits away. Every change
// is an operation on element paths (child indexes from <body>), so the
// snapshot plus the list of operations always rebuilds the same page: that
// list is what undo, redo and share links use. Text is stored as sanitised
// markup, never as scripts or event handlers.
(function () {
  if (window.__sbsFS) return;
  var doc = document;
  var ACCENT = '#7c3aed';

  var pristine = null; // <body> as it was when Freestyle started
  var ops = [];
  var redo = [];
  var selected = null; // element
  var editing = null; // element being text-edited
  var dragging = null;
  var active = false;
  var onChange = function () {};

  // ---------------------------------------------------------------- overlay
  // Lives on <html>, outside <body>, in a shadow root so the site's CSS can't touch it.
  var host = doc.createElement('sbs-freestyle');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  var shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML =
    '<style>' +
    ':host{all:initial}' +
    '.box{position:fixed;pointer-events:none;box-sizing:border-box;border-radius:3px}' +
    '.hover{border:1px dashed ' + ACCENT + 'aa;background:' + ACCENT + '0d}' +
    '.sel{border:2px solid ' + ACCENT + ';box-shadow:0 0 0 1px #fff}' +
    '.drop{position:fixed;height:4px;background:' + ACCENT + ';border-radius:2px;pointer-events:none;box-shadow:0 0 0 2px #fff}' +
    '.bar{position:fixed;display:flex;align-items:center;gap:2px;padding:3px;background:#1f1633;border-radius:9px;' +
    'box-shadow:0 6px 18px rgba(0,0,0,.3);pointer-events:auto;font:12px/1 Inter,system-ui,sans-serif;color:#fff;white-space:nowrap}' +
    '.bar button{all:unset;cursor:pointer;min-width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;font-size:14px;padding:0 4px}' +
    '.bar button:hover{background:#ffffff22}.bar button:focus-visible{outline:2px solid #c4b5fd}' +
    '.bar button[disabled]{opacity:.35;cursor:default}.bar .grip{cursor:grab}' +
    '.bar .tag{padding:0 6px 0 4px;color:#c4b5fd;max-width:150px;overflow:hidden;text-overflow:ellipsis}' +
    '.bar .sep{width:1px;height:16px;background:#ffffff33;margin:0 2px}' +
    '[hidden]{display:none!important}' +
    '</style>' +
    '<div class="box hover" hidden></div><div class="box sel" hidden></div><div class="drop" hidden></div>' +
    '<div class="bar" hidden>' +
    '<button class="grip" data-a="drag" title="Drag to a new spot">⠿</button>' +
    '<span class="tag"></span><span class="sep"></span>' +
    '<button data-a="up" title="Move up (Alt+↑)">↑</button>' +
    '<button data-a="down" title="Move down (Alt+↓)">↓</button>' +
    '<button data-a="parent" title="Select the section around it">⇱</button>' +
    '<button data-a="edit" title="Edit text (double-click)">✎</button>' +
    '<button data-a="dup" title="Duplicate">⧉</button>' +
    '<button data-a="del" title="Delete (Del)">🗑</button>' +
    '</div>';
  var hoverBox = shadow.querySelector('.hover');
  var selBox = shadow.querySelector('.sel');
  var dropLine = shadow.querySelector('.drop');
  var bar = shadow.querySelector('.bar');
  var tagLabel = shadow.querySelector('.tag');

  // ---------------------------------------------------------------- paths
  function pathOf(el) {
    var p = [];
    for (var n = el; n && n !== doc.body; n = n.parentElement) {
      var i = 0;
      for (var s = n.previousElementSibling; s; s = s.previousElementSibling) i++;
      p.unshift(i);
    }
    return n === doc.body ? p : null;
  }
  function resolve(p) {
    var n = doc.body;
    for (var i = 0; n && p && i < p.length; i++) n = n.children[p[i]];
    return n && n !== doc.body ? n : null;
  }
  var editable = function (el) { return el && el !== doc.body && el !== doc.documentElement && el.nodeType === 1 && doc.body.contains(el); };

  // ---------------------------------------------------------------- sanitising
  var ALLOWED = { B: 1, STRONG: 1, I: 1, EM: 1, U: 1, BR: 1, SPAN: 1, SMALL: 1, SUP: 1, SUB: 1, A: 1, P: 1, DIV: 1 };
  function cleanInto(src, out) {
    Array.prototype.forEach.call(src.childNodes, function (c) {
      if (c.nodeType === 3) { out.appendChild(doc.createTextNode(c.data)); return; }
      if (c.nodeType !== 1) return;
      if (!ALLOWED[c.tagName]) { cleanInto(c, out); return; }
      var e = doc.createElement(c.tagName);
      if (c.getAttribute('class')) e.setAttribute('class', c.getAttribute('class'));
      if (c.tagName === 'A' && /^(https?:|#|\/)/i.test(c.getAttribute('href') || '')) e.setAttribute('href', c.getAttribute('href'));
      cleanInto(c, e);
      out.appendChild(e);
    });
  }
  function cleanHtml(html) {
    var parsed = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html'); // inert: nothing runs
    var div = doc.createElement('div');
    cleanInto(parsed.body.firstChild, div);
    return div;
  }

  // ---------------------------------------------------------------- new elements
  function buttonTemplate() {
    var all = doc.body.querySelectorAll('a, button');
    for (var i = 0; i < all.length; i++) {
      var b = all[i], r = b.getBoundingClientRect(), st = getComputedStyle(b);
      var text = (b.textContent || '').trim();
      var filled = st.backgroundColor && !/rgba\(0, 0, 0, 0\)|transparent/.test(st.backgroundColor);
      if (filled && r.height >= 28 && r.height <= 80 && r.width >= 60 && text.length >= 2 && text.length <= 40 && !b.closest('[data-sbs-added]')) return b;
    }
    return null;
  }
  function make(op) {
    var n;
    if (op.k === 'button') {
      var tpl = op.tp ? resolve(op.tp) : null;
      if (tpl) {
        n = tpl.cloneNode(true);
        n.removeAttribute('id');
        if (n.tagName === 'A') n.setAttribute('href', '#');
        if (n.tagName === 'BUTTON') n.setAttribute('type', 'button');
        n.textContent = op.v;
      } else {
        n = doc.createElement('a');
        n.href = '#';
        n.textContent = op.v;
        n.style.cssText = 'display:inline-block;padding:12px 24px;border-radius:999px;background:' + ACCENT + ';color:#fff;font-weight:700;text-decoration:none;';
      }
      var wrap = doc.createElement('div');
      wrap.style.cssText = 'margin:12px 0;';
      wrap.appendChild(n);
      n = wrap;
    } else if (op.k === 'text') {
      n = doc.createElement('p');
      n.textContent = op.v;
      n.style.cssText = 'margin:12px 0;';
    } else if (op.k === 'image') {
      n = doc.createElement('div');
      n.textContent = op.v || 'Image';
      n.style.cssText = 'margin:12px 0;width:100%;max-width:100%;aspect-ratio:16/9;border-radius:16px;display:flex;align-items:center;justify-content:center;' +
        'background:repeating-linear-gradient(45deg,#efe9fd,#efe9fd 14px,#e4dbfb 14px,#e4dbfb 28px);color:#6d5bb3;font:600 16px system-ui,sans-serif;';
    } else {
      n = doc.createElement('div');
      n.style.cssText = 'height:48px;';
    }
    n.setAttribute('data-sbs-added', op.k);
    return n;
  }

  // ---------------------------------------------------------------- operations
  function apply(op) {
    var el = resolve(op.p);
    if (!el && op.o !== 'add') return null;
    switch (op.o) {
      case 'del': el.remove(); return null;
      case 'dup': { var c = el.cloneNode(true); el.parentNode.insertBefore(c, el.nextSibling); return c; }
      case 'mv': {
        var t = resolve(op.t);
        if (!t || el === t || el.contains(t)) return el;
        t.parentNode.insertBefore(el, op.w === 'b' ? t : t.nextSibling);
        return el;
      }
      case 'txt': {
        el.innerHTML = '';
        var clean = cleanHtml(op.v);
        while (clean.firstChild) el.appendChild(clean.firstChild);
        return el;
      }
      case 'add': {
        var ref = resolve(op.p);
        if (!ref) return null;
        var n = make(op);
        ref.parentNode.insertBefore(n, ref.nextSibling);
        return n;
      }
    }
    return null;
  }

  function notify() {
    onChange(ops.slice(), {
      count: ops.length, canUndo: ops.length > 0, canRedo: redo.length > 0,
      selected: selected ? describe(selected) : null,
    });
  }

  /** Apply a new operation to the page as it is now, and keep it. */
  function commit(op, select) {
    var result = apply(op);
    ops.push(op);
    redo = [];
    setSelected(select === undefined ? result : select);
    notify();
  }

  /** Rebuild the page from the snapshot and the operations (undo, redo, reset, load). */
  function render(keepPath) {
    var y = window.scrollY;
    var body = pristine.cloneNode(true);
    doc.documentElement.replaceChild(body, doc.body);
    ops.forEach(apply);
    window.scrollTo(0, y);
    setSelected(keepPath ? resolve(keepPath) : null);
    notify();
  }

  // ---------------------------------------------------------------- selection UI
  function describe(el) {
    var cls = (el.getAttribute('class') || '').trim().split(/\s+/)[0];
    var t = el.getAttribute('data-sbs-added') ? 'new ' + el.getAttribute('data-sbs-added') : el.tagName.toLowerCase() + (cls ? '.' + cls.slice(0, 24) : '');
    return t;
  }
  function place(box, el) {
    if (!el || !doc.body.contains(el)) { box.hidden = true; return null; }
    var r = el.getBoundingClientRect();
    box.hidden = false;
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
    return r;
  }
  function setSelected(el) {
    selected = editable(el) ? el : null;
    position();
  }
  function position() {
    if (!active) return;
    var r = place(selBox, selected);
    bar.hidden = !r || !!dragging;
    if (!r) return;
    tagLabel.textContent = describe(selected);
    var bw = bar.offsetWidth, bh = bar.offsetHeight;
    var top = r.top - bh - 6;
    if (top < 4) top = r.bottom + 6 > innerHeight - bh - 4 ? Math.max(4, r.top + 4) : r.bottom + 6;
    bar.style.top = top + 'px';
    bar.style.left = Math.max(4, Math.min(r.left, innerWidth - bw - 4)) + 'px';
    shadow.querySelector('[data-a=up]').disabled = !selected.previousElementSibling;
    shadow.querySelector('[data-a=down]').disabled = !selected.nextElementSibling;
    shadow.querySelector('[data-a=parent]').disabled = !editable(selected.parentElement);
  }
  var raf = 0;
  function loop() {
    if (!active) return;
    position();
    if (hovered) place(hoverBox, hovered);
    raf = requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------- actions
  function startEdit(el) {
    if (!el) return;
    editing = el;
    el.setAttribute('contenteditable', 'true');
    el.focus();
    var range = doc.createRange();
    range.selectNodeContents(el);
    var s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
  }
  function endEdit() {
    if (!editing) return;
    var el = editing;
    editing = null;
    el.removeAttribute('contenteditable');
    var html = cleanHtml(el.innerHTML).innerHTML;
    commit({ o: 'txt', p: pathOf(el), v: html }, el);
  }
  function act(a) {
    var el = selected;
    if (!el) return;
    var p = pathOf(el);
    if (a === 'up' && el.previousElementSibling) commit({ o: 'mv', p: p, t: pathOf(el.previousElementSibling), w: 'b' });
    else if (a === 'down' && el.nextElementSibling) commit({ o: 'mv', p: p, t: pathOf(el.nextElementSibling), w: 'a' });
    else if (a === 'dup') commit({ o: 'dup', p: p });
    else if (a === 'del') commit({ o: 'del', p: p }, null);
    else if (a === 'parent' && editable(el.parentElement)) { setSelected(el.parentElement); notify(); }
    else if (a === 'edit') startEdit(el);
  }

  // Where would a drop go? Prefer a sibling of the dragged element, so moving a
  // section reorders sections rather than dropping it inside a paragraph.
  function dropTarget(x, y) {
    host.style.display = 'none';
    var t = doc.elementFromPoint(x, y);
    host.style.display = '';
    if (!editable(t) || dragging.el.contains(t)) return null;
    var parent = dragging.el.parentElement;
    if (parent && parent.contains(t)) {
      while (t.parentElement !== parent) t = t.parentElement;
    } else {
      var want = dragging.el.getBoundingClientRect().width * 0.8;
      while (t.parentElement && t.parentElement !== doc.body && t.getBoundingClientRect().width < want) t = t.parentElement;
    }
    if (t === dragging.el) return null;
    var r = t.getBoundingClientRect();
    return { el: t, before: y < r.top + r.height / 2, rect: r };
  }

  // ---------------------------------------------------------------- events
  var hovered = null;
  var ours = function (e) { return e.composedPath && e.composedPath().indexOf(host) >= 0; };
  var inEdit = function (e) { return editing && editing.contains(e.target); };

  function onMove(e) {
    if (dragging) {
      var d = dropTarget(e.clientX, e.clientY);
      dragging.drop = d;
      if (!d) { dropLine.hidden = true; return; }
      dropLine.hidden = false;
      dropLine.style.left = d.rect.left + 'px';
      dropLine.style.width = d.rect.width + 'px';
      dropLine.style.top = (d.before ? d.rect.top : d.rect.bottom) - 2 + 'px';
      return;
    }
    if (ours(e) || editing) { hoverBox.hidden = true; hovered = null; return; }
    hovered = editable(e.target) ? e.target : null;
    if (!hovered) hoverBox.hidden = true;
  }
  function onDown(e) {
    if (ours(e)) {
      var b = e.composedPath()[0].closest && e.composedPath()[0].closest('button');
      if (b && b.dataset.a === 'drag' && selected) {
        e.preventDefault();
        dragging = { el: selected, drop: null };
        bar.hidden = true;
        hoverBox.hidden = true;
      }
      return;
    }
    if (inEdit(e)) return;
    e.preventDefault(); // no text selection, focus or native drag on the page
    e.stopImmediatePropagation();
    window.focus(); // ...but keep keyboard shortcuts (Delete, Ctrl+Z) coming to the page
  }
  function onUp(e) {
    if (!dragging) return;
    var d = dragging.drop, el = dragging.el;
    dragging = null;
    dropLine.hidden = true;
    if (d) commit({ o: 'mv', p: pathOf(el), t: pathOf(d.el), w: d.before ? 'b' : 'a' });
    else position();
    e.stopImmediatePropagation();
  }
  function onClick(e) {
    if (ours(e)) {
      var b = e.composedPath()[0].closest && e.composedPath()[0].closest('button');
      if (b && b.dataset.a && b.dataset.a !== 'drag') act(b.dataset.a);
      return;
    }
    if (inEdit(e)) return;
    e.preventDefault(); // links don't navigate, buttons don't submit
    e.stopImmediatePropagation();
    if (editing) endEdit();
    setSelected(e.target);
    notify();
  }
  function onDbl(e) {
    if (ours(e) || inEdit(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    setSelected(e.target);
    startEdit(selected);
  }
  function onKey(e) {
    if (editing) {
      if (e.key === 'Escape') { e.preventDefault(); endEdit(); }
      return;
    }
    var mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) api.redo(); else api.undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); api.redo(); return; }
    if (!selected) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); act('del'); }
    else if (e.key === 'Escape') { setSelected(null); notify(); }
    else if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); act('up'); }
    else if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); act('down'); }
    else if (e.key === 'Enter') { e.preventDefault(); act('edit'); }
  }
  var block = function (e) { if (!ours(e) && !inEdit(e)) { e.preventDefault(); e.stopImmediatePropagation(); } };
  var LISTENERS = [
    ['mousemove', onMove], ['mousedown', onDown], ['mouseup', onUp], ['click', onClick], ['dblclick', onDbl],
    ['keydown', onKey], ['submit', block], ['auxclick', block], ['dragstart', block], ['pointerdown', function (e) { if (!ours(e) && !inEdit(e)) e.stopImmediatePropagation(); }],
  ];

  // ---------------------------------------------------------------- API
  var api = {
    /** Freeze the page, apply `opts.ops`, and start editing. */
    start: function (opts) {
      opts = opts || {};
      onChange = opts.onChange || onChange;
      if (!active) {
        active = true;
        window.__sbsFreestyle = true; // tells the device emulation to stand aside
        pristine = doc.body.cloneNode(true);
        Array.prototype.forEach.call(pristine.querySelectorAll('script, noscript'), function (s) { s.remove(); });
        doc.documentElement.appendChild(host);
        LISTENERS.forEach(function (l) { window.addEventListener(l[0], l[1], true); });
        raf = requestAnimationFrame(loop);
      }
      ops = (opts.ops || []).slice();
      redo = [];
      render(null);
    },
    stop: function () {
      if (!active) return;
      if (editing) endEdit();
      active = false;
      window.__sbsFreestyle = false;
      cancelAnimationFrame(raf);
      LISTENERS.forEach(function (l) { window.removeEventListener(l[0], l[1], true); });
      host.remove();
    },
    /** Add an element after the selection. */
    add: function (kind, text) {
      if (!selected) return false;
      var op = { o: 'add', p: pathOf(selected), k: kind, v: text || '' };
      if (kind === 'button') { var tpl = buttonTemplate(); if (tpl) op.tp = pathOf(tpl); }
      commit(op);
      return true;
    },
    undo: function () { if (editing) endEdit(); if (!ops.length) return; redo.push(ops.pop()); render(null); },
    redo: function () { if (!redo.length) return; var r = redo.pop(); ops.push(r); var keep = redo; render(null); redo = keep; notify(); },
    reset: function () { ops = []; redo = []; render(null); },
    setCapturing: function (on) { host.style.visibility = on ? 'hidden' : ''; },
    isActive: function () { return active; },
  };
  window.__sbsFS = api;
})();
