// Freestyle editor. Runs inside the proxied page (loaded on demand by the
// Side by Side UI) and turns it into an editable canvas, Figma/Notion style:
// click selects a block (click again to go deeper), press-and-drag moves it
// with a live preview, and new elements are placed by clicking where they go.
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
  var selected = null;
  var editing = null;  // element being text-edited
  var pressed = null;  // mouse is down on the page, not yet a drag
  var dragging = null; // { el, ghost, drop, dx, dy }
  var placing = null;  // { kind, text, drop }
  var hovered = null;
  var pointer = { x: 0, y: 0 };
  var active = false;
  var onChange = function () {};
  // 'edit' = rearrange this page; 'library' = read-only source that blocks are
  // dragged out of, onto the Freestyle artboard (reported via onExternal).
  var mode = 'edit';
  var onExternal = function () {};
  var external = null; // { el } while dragging a block out of the library

  // ---------------------------------------------------------------- overlay
  // Lives on <html>, outside <body>, in a shadow root so the site's CSS can't touch it.
  var host = doc.createElement('sbs-freestyle');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  var shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML =
    '<style>' +
    ':host{all:initial}' +
    '.box{position:fixed;pointer-events:none;box-sizing:border-box;border-radius:4px}' +
    '.hover{border:1.5px solid ' + ACCENT + '88}' +
    '.sel{border:2px solid ' + ACCENT + ';box-shadow:0 0 0 1px #fff, 0 0 0 4px ' + ACCENT + '22}' +
    '.zone{border:2px dashed ' + ACCENT + '66;background:' + ACCENT + '08}' +
    '.drop{position:fixed;height:4px;background:' + ACCENT + ';border-radius:3px;pointer-events:none;box-shadow:0 0 0 2px #fff}' +
    '.drop::before,.drop::after{content:"";position:absolute;top:-4px;width:12px;height:12px;border-radius:50%;background:' + ACCENT + ';box-shadow:0 0 0 2px #fff}' +
    '.drop::before{left:-6px}.drop::after{right:-6px}' +
    '.drop span{position:absolute;left:50%;top:-30px;transform:translateX(-50%);background:' + ACCENT + ';color:#fff;font:600 12px/1 Inter,system-ui,sans-serif;padding:6px 10px;border-radius:999px;white-space:nowrap}' +
    '.tip{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);background:#1f1633;color:#fff;font:500 13px/1.3 Inter,system-ui,sans-serif;padding:8px 14px;border-radius:999px;box-shadow:0 6px 18px rgba(0,0,0,.3);white-space:nowrap}' +
    '.bar{position:fixed;display:flex;align-items:center;gap:2px;padding:4px;background:#1f1633;border-radius:12px;' +
    'box-shadow:0 8px 24px rgba(0,0,0,.3);pointer-events:auto;font:13px/1 Inter,system-ui,sans-serif;color:#fff;white-space:nowrap}' +
    '.bar button{all:unset;cursor:pointer;min-width:34px;height:34px;display:inline-flex;align-items:center;justify-content:center;border-radius:8px;font-size:16px;padding:0 6px;gap:6px}' +
    '.bar button:hover{background:#ffffff22}.bar button:focus-visible{outline:2px solid #c4b5fd}' +
    '.bar button[disabled]{opacity:.35;cursor:default}.bar button[data-a=drag]{cursor:grab;font-size:13px}' +
    '.bar .tag{padding:0 8px 0 4px;color:#c4b5fd;max-width:170px;overflow:hidden;text-overflow:ellipsis;font-size:12px}' +
    '.bar .sep{width:1px;height:20px;background:#ffffff33;margin:0 2px}' +
    '[hidden]{display:none!important}' +
    '</style>' +
    '<div class="box zone" hidden></div><div class="box hover" hidden></div><div class="box sel" hidden></div>' +
    '<div class="drop" hidden><span>Drop here</span></div><div class="tip" hidden></div>' +
    '<div class="bar" hidden>' +
    '<button data-a="drag" title="Drag to move (or just press and drag the element)">⠿ Move</button>' +
    '<span class="tag"></span><span class="sep"></span>' +
    '<button data-a="up" title="Move up (Alt+↑)">↑</button>' +
    '<button data-a="down" title="Move down (Alt+↓)">↓</button>' +
    '<button data-a="parent" title="Select the block around it (Esc)">⇱</button>' +
    '<button data-a="edit" title="Edit text (Enter or double-click)">✎</button>' +
    '<button data-a="dup" title="Duplicate (Ctrl+D)">⧉</button>' +
    '<button data-a="del" title="Delete (Del)">🗑</button>' +
    '</div>';
  var zoneBox = shadow.querySelector('.zone');
  var hoverBox = shadow.querySelector('.hover');
  var selBox = shadow.querySelector('.sel');
  var dropLine = shadow.querySelector('.drop');
  var tip = shadow.querySelector('.tip');
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
    if (!el) return null;
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
        var n = make(op);
        el.parentNode.insertBefore(n, op.w === 'b' ? el : el.nextSibling);
        return n;
      }
    }
    return null;
  }

  function notify() {
    onChange(ops.slice(), {
      count: ops.length, canUndo: ops.length > 0, canRedo: redo.length > 0,
      selected: selected ? describe(selected) : null, placing: placing ? placing.kind : null,
      selectedPath: selected ? pathOf(selected) : null,
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
  function render() {
    var y = window.scrollY;
    var body = pristine.cloneNode(true);
    doc.documentElement.replaceChild(body, doc.body);
    ops.forEach(apply);
    window.scrollTo(0, y);
    setSelected(null);
    notify();
  }

  // ---------------------------------------------------------------- picking blocks
  var visible = function (el) { var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

  /**
   * The block a first click should select: the outermost element under the
   * pointer that is one of several siblings and isn't a page-sized wrapper
   * (a section, a card, a row, a button group).
   */
  function blockAt(t) {
    if (!editable(t)) return null;
    var chain = [];
    for (var n = t; n && n !== doc.body; n = n.parentElement) chain.unshift(n);
    var pageH = Math.max(doc.documentElement.scrollHeight, innerHeight);
    for (var i = 0; i < chain.length; i++) {
      var el = chain[i];
      var siblings = Array.prototype.filter.call(el.parentElement.children, visible).length;
      var h = el.getBoundingClientRect().height;
      if (siblings > 1 && h < pageH * 0.6 && visible(el)) return el;
    }
    return t;
  }
  /** One level deeper than the selection, towards `t` (click again to drill in). */
  function deeper(t) {
    for (var n = t; n && n.parentElement; n = n.parentElement) if (n.parentElement === selected) return n;
    return t;
  }
  function pick(t, exact) {
    if (exact) return t;
    if (selected && selected !== t && selected.contains(t)) return deeper(t);
    if (selected === t) return t;
    return blockAt(t);
  }

  // ---------------------------------------------------------------- selection UI
  function describe(el) {
    var cls = (el.getAttribute('class') || '').trim().split(/\s+/)[0];
    if (el.getAttribute('data-sbs-added')) return 'new ' + el.getAttribute('data-sbs-added');
    var txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return el.tagName.toLowerCase() + (cls ? '.' + cls.slice(0, 20) : '') + (txt ? ' “' + txt.slice(0, 24) + (txt.length > 24 ? '…' : '') + '”' : '');
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
    var r = place(selBox, dragging || external ? null : selected);
    bar.hidden = !r || !!dragging || !!placing || !!editing || mode === 'library';
    if (bar.hidden) return;
    tagLabel.textContent = describe(selected);
    var bw = bar.offsetWidth, bh = bar.offsetHeight;
    var top = r.top - bh - 8;
    if (top < 6) top = r.bottom + 8 > innerHeight - bh - 6 ? Math.max(6, r.top + 6) : r.bottom + 8;
    bar.style.top = top + 'px';
    bar.style.left = Math.max(6, Math.min(r.left, innerWidth - bw - 6)) + 'px';
    shadow.querySelector('[data-a=up]').disabled = !selected.previousElementSibling;
    shadow.querySelector('[data-a=down]').disabled = !selected.nextElementSibling;
    shadow.querySelector('[data-a=parent]').disabled = !editable(selected.parentElement);
  }
  function showTip(text) { tip.hidden = !text; tip.textContent = text || ''; }

  // ---------------------------------------------------------------- frame loop
  // Keeps the outlines on their elements, and scrolls the page when a drag or
  // placement nears the top or bottom edge.
  var raf = 0;
  function loop() {
    if (!active) return;
    if ((dragging || placing) && !editing) {
      var edge = 70, speed = 0;
      if (pointer.y < edge) speed = -Math.ceil((edge - pointer.y) / 4);
      else if (pointer.y > innerHeight - edge) speed = Math.ceil((pointer.y - (innerHeight - edge)) / 4);
      if (speed) { window.scrollBy(0, speed); updateDrop(); }
    }
    position();
    if (hovered && !dragging) place(hoverBox, hovered); else hoverBox.hidden = true;
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
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    position();
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

  // ---------------------------------------------------------------- drop targets
  function elementAt(x, y) {
    host.style.display = 'none';
    if (dragging && dragging.ghost) dragging.ghost.style.display = 'none';
    var t = doc.elementFromPoint(x, y);
    host.style.display = '';
    if (dragging && dragging.ghost) dragging.ghost.style.display = '';
    return t;
  }
  /**
   * Where a drop would go: next to a sibling of the dragged element where
   * possible (so sections reorder as sections), otherwise next to the block
   * under the pointer.
   */
  function dropAt(x, y) {
    var t = elementAt(x, y);
    if (!editable(t)) return null;
    var moving = dragging && dragging.el;
    if (moving && moving.contains(t)) return null;
    if (moving && moving.parentElement && moving.parentElement.contains(t) && moving.parentElement !== t) {
      while (t.parentElement !== moving.parentElement) t = t.parentElement;
    } else {
      t = blockAt(t) || t;
      if (moving) {
        var want = moving.getBoundingClientRect().width * 0.7;
        while (t.parentElement && t.parentElement !== doc.body && t.getBoundingClientRect().width < want) t = t.parentElement;
      }
    }
    if (!editable(t) || t === moving) return null;
    var r = t.getBoundingClientRect();
    return { el: t, before: y < r.top + r.height / 2, rect: r };
  }
  function updateDrop() {
    var state = dragging || placing;
    if (!state) return;
    var d = dropAt(pointer.x, pointer.y);
    state.drop = d;
    if (!d) { dropLine.hidden = true; zoneBox.hidden = true; return; }
    dropLine.hidden = false;
    dropLine.style.left = d.rect.left + 'px';
    dropLine.style.width = Math.max(40, d.rect.width) + 'px';
    dropLine.style.top = (d.before ? d.rect.top : d.rect.bottom) - 2 + 'px';
    place(zoneBox, d.el.parentElement !== doc.body ? d.el.parentElement : null);
  }

  // ---------------------------------------------------------------- dragging
  function startDrag(el, e) {
    var r = el.getBoundingClientRect();
    var ghost = el.cloneNode(true);
    ghost.removeAttribute('id');
    Object.assign(ghost.style, {
      position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', margin: '0',
      opacity: '0.75', pointerEvents: 'none', zIndex: '2147483646', boxShadow: '0 18px 40px rgba(31,22,51,.35)',
      transform: 'rotate(1deg) scale(0.98)', transition: 'none', overflow: 'hidden', background: getComputedStyle(el).backgroundColor === 'rgba(0, 0, 0, 0)' ? '#fff' : '',
    });
    doc.body.appendChild(ghost);
    dragging = { el: el, ghost: ghost, drop: null, dx: e.clientX - r.left, dy: e.clientY - r.top, opacity: el.style.opacity };
    el.style.opacity = '0.3';
    doc.documentElement.style.cursor = 'grabbing';
    setSelected(el);
    showTip('Drop it where the line shows · Esc to cancel');
    moveGhost();
    updateDrop();
  }
  function moveGhost() {
    if (!dragging) return;
    dragging.ghost.style.left = pointer.x - dragging.dx + 'px';
    dragging.ghost.style.top = pointer.y - dragging.dy + 'px';
  }
  function endDrag(cancel) {
    var d = dragging;
    dragging = null;
    d.ghost.remove(); // before computing paths, so it doesn't count
    d.el.style.opacity = d.opacity;
    doc.documentElement.style.cursor = '';
    dropLine.hidden = true;
    zoneBox.hidden = true;
    showTip(null);
    if (!cancel && d.drop && d.drop.el !== d.el) {
      commit({ o: 'mv', p: pathOf(d.el), t: pathOf(d.drop.el), w: d.drop.before ? 'b' : 'a' });
    } else {
      setSelected(d.el);
    }
  }

  // ---------------------------------------------------------------- placing new elements
  var NAMES = { button: 'button', text: 'text', image: 'image', spacer: 'spacer' };
  function startPlacing(kind, text) {
    if (editing) endEdit();
    placing = { kind: kind, text: text, drop: null };
    doc.documentElement.style.cursor = 'copy';
    showTip('Click where the new ' + NAMES[kind] + ' should go · Esc to cancel');
    position();
    notify();
  }
  function endPlacing(drop) {
    var p = placing;
    placing = null;
    doc.documentElement.style.cursor = '';
    dropLine.hidden = true;
    zoneBox.hidden = true;
    showTip(null);
    if (drop) {
      var op = { o: 'add', p: pathOf(drop.el), w: drop.before ? 'b' : 'a', k: p.kind, v: p.text || '' };
      if (p.kind === 'button') { var tpl = buttonTemplate(); if (tpl) op.tp = pathOf(tpl); }
      commit(op);
    } else {
      notify();
    }
  }

  // ---------------------------------------------------------------- events
  var ours = function (e) { return e.composedPath && e.composedPath().indexOf(host) >= 0; };
  var inEdit = function (e) { return editing && editing.contains(e.target); };
  var barButton = function (e) { var t = e.composedPath()[0]; return t && t.closest ? t.closest('button') : null; };

  function onMove(e) {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    if (pressed && !dragging && !external && Math.abs(e.clientX - pressed.x) + Math.abs(e.clientY - pressed.y) > 5) {
      if (mode === 'library') startExternal(pressed.el, pressed.e);
      else startDrag(pressed.el, pressed.e);
      pressed = null;
    }
    if (external) { onExternal({ phase: 'move', x: e.clientX, y: e.clientY }); return; }
    if (dragging) { moveGhost(); updateDrop(); return; }
    if (placing) { updateDrop(); return; }
    if (ours(e) || editing) { hovered = null; return; }
    hovered = editable(e.target) ? pick(e.target, e.ctrlKey || e.metaKey) : null;
  }
  function onDown(e) {
    if (e.button !== 0) return;
    swallowClick = false;
    if (ours(e)) {
      var b = barButton(e);
      if (b && b.dataset.a === 'drag' && selected) {
        e.preventDefault();
        pointer.x = e.clientX; pointer.y = e.clientY;
        startDrag(selected, e);
      }
      return;
    }
    if (inEdit(e)) return;
    e.preventDefault(); // no text selection, focus or native drag on the page
    e.stopImmediatePropagation();
    window.focus(); // ...but keep keyboard shortcuts (Delete, Ctrl+Z) coming to the page
    if (placing || !editable(e.target)) return;
    // Press-and-drag moves the block (or the selection, if pressing inside it).
    var el = selected && selected.contains(e.target) ? selected : pick(e.target, e.ctrlKey || e.metaKey);
    pressed = { el: el, x: e.clientX, y: e.clientY, e: { clientX: e.clientX, clientY: e.clientY } };
  }
  function startExternal(el, e) {
    var r = el.getBoundingClientRect();
    external = { el: el };
    setSelected(el);
    hovered = null;
    doc.documentElement.style.cursor = 'grabbing';
    onExternal({
      phase: 'start', path: pathOf(el), label: describe(el), w: r.width, h: r.height,
      dx: e.clientX - r.left, dy: e.clientY - r.top, x: e.clientX, y: e.clientY,
    });
  }
  function endExternal(e, cancel) {
    external = null;
    doc.documentElement.style.cursor = '';
    onExternal(cancel ? { phase: 'cancel' } : { phase: 'end', x: e.clientX, y: e.clientY });
    position();
  }

  function onUp(e) {
    pressed = null;
    if (external) { endExternal(e, false); e.stopImmediatePropagation(); swallowClick = true; return; }
    if (!dragging) return;
    endDrag(false);
    e.stopImmediatePropagation();
    swallowClick = true;
  }
  var swallowClick = false;
  function onClick(e) {
    if (ours(e)) {
      var b = barButton(e);
      if (b && b.dataset.a && b.dataset.a !== 'drag') act(b.dataset.a);
      return;
    }
    if (inEdit(e)) return;
    e.preventDefault(); // links don't navigate, buttons don't submit
    e.stopImmediatePropagation();
    if (swallowClick) { swallowClick = false; return; } // the end of a drag
    if (placing) { updateDrop(); endPlacing(placing.drop); return; }
    if (editing) endEdit();
    setSelected(pick(e.target, e.ctrlKey || e.metaKey));
    notify();
  }
  function onDbl(e) {
    if (ours(e) || inEdit(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (mode === 'library') return;
    setSelected(e.target); // the exact thing under the pointer
    startEdit(selected);
  }
  function onKey(e) {
    if (editing) {
      if (e.key === 'Escape') { e.preventDefault(); endEdit(); }
      return;
    }
    if (e.key === 'Escape') {
      if (external) { endExternal(e, true); return; }
      if (dragging) { endDrag(true); return; }
      if (placing) { endPlacing(null); return; }
    }
    if (mode === 'library') return; // the library is read-only
    var mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) api.redo(); else api.undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); api.redo(); return; }
    if (!selected) return;
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); act('dup'); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); act('del'); }
    else if (e.key === 'Escape') { if (editable(selected.parentElement)) setSelected(selected.parentElement); else setSelected(null); notify(); }
    else if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); act('up'); }
    else if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); act('down'); }
    else if (e.key === 'Enter') { e.preventDefault(); act('edit'); }
  }
  var block = function (e) { if (!ours(e) && !inEdit(e)) { e.preventDefault(); e.stopImmediatePropagation(); } };
  var LISTENERS = [
    ['mousemove', onMove], ['mousedown', onDown], ['mouseup', onUp], ['click', onClick], ['dblclick', onDbl],
    ['keydown', onKey], ['submit', block], ['auxclick', block], ['dragstart', block],
    ['pointerdown', function (e) { if (!ours(e) && !inEdit(e)) e.stopImmediatePropagation(); }],
  ];

  // ---------------------------------------------------------------- API
  var api = {
    /** Freeze the page, apply `opts.ops`, and start editing. */
    start: function (opts) {
      opts = opts || {};
      onChange = opts.onChange || onChange;
      mode = opts.mode || 'edit';
      onExternal = opts.onExternal || onExternal;
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
      render();
    },
    stop: function () {
      if (!active) return;
      if (editing) endEdit();
      if (dragging) endDrag(true);
      active = false;
      window.__sbsFreestyle = false;
      cancelAnimationFrame(raf);
      LISTENERS.forEach(function (l) { window.removeEventListener(l[0], l[1], true); });
      host.remove();
    },
    /** Next click on the page places a new element there. */
    place: function (kind, text) { startPlacing(kind, text); },
    cancelPlace: function () { if (placing) endPlacing(null); },
    /** Add an element right after the selection. */
    add: function (kind, text) {
      if (!selected) return false;
      var op = { o: 'add', p: pathOf(selected), w: 'a', k: kind, v: text || '' };
      if (kind === 'button') { var tpl = buttonTemplate(); if (tpl) op.tp = pathOf(tpl); }
      commit(op);
      return true;
    },
    undo: function () { if (editing) endEdit(); if (!ops.length) return; redo.push(ops.pop()); render(); },
    redo: function () { if (!redo.length) return; ops.push(redo.pop()); var keep = redo; render(); redo = keep; notify(); },
    reset: function () { ops = []; redo = []; render(); },
    setCapturing: function (on) { host.style.visibility = on ? 'hidden' : ''; },
    isActive: function () { return active; },
    /** The parent finished a drag out of the library itself (it caught the mouse-up). */
    endExternal: function () { if (external) { external = null; doc.documentElement.style.cursor = ''; position(); } },
    /** Live element for a path (the library's frozen page), for copying onto the artboard. */
    elementAt: function (p) { return resolve(p); },
    /** Path of the site's own filled button, to copy for "Add button". */
    buttonPath: function () { var b = buttonTemplate(); return b ? pathOf(b) : null; },
  };
  window.__sbsFS = api;
})();
