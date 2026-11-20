// Freestyle: turns the live pane into an editable mockup of the page.
// The editor itself runs inside the page (freestyle-editor.js); this file is
// the panel, the layout (optionally the original next to it), screenshots
// and share links.
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var btn = $('freestyleBtn');
  var panel = $('fsPanel');
  var notesPanel = $('notesPanel');
  var toast = function (m) { window.SBS && window.SBS.toast(m); };
  var liveFrame = function () { return document.querySelector('.pane[data-role="live"] iframe'); };

  var on = false;
  var ops = [];
  var editor = null;

  function setInfo(info) {
    info = info || { count: ops.length, canUndo: ops.length > 0, canRedo: false, selected: null };
    $('fsSel').textContent = info.selected ? 'Selected: ' + info.selected : 'Nothing selected';
    $('fsSel').classList.toggle('on', !!info.selected);
    $('fsCount').textContent = info.count ? info.count + ' change' + (info.count > 1 ? 's' : '') : 'No changes yet';
    $('fsUndo').disabled = !info.canUndo;
    $('fsRedo').disabled = !info.canRedo;
    $('fsReset').disabled = !info.count;
    panel.querySelectorAll('[data-add]').forEach(function (b) {
      b.disabled = !info.selected;
      b.title = info.selected ? 'Add after the selected element' : 'Select an element on the page first';
    });
  }

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
  function inject(frame) {
    if (!on) return;
    var w = frame.contentWindow;
    var start = function () {
      editor = w.__sbsFS;
      editor.start({ ops: ops, onChange: function (list, info) { ops = list; setInfo(info); } });
    };
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

  function open(data) {
    if (!window.SBS.ensureLive()) { toast('Enter a website in Live first'); return; }
    if (!notesPanel.hidden) $('annotateClose').click();
    on = true;
    ops = (data && data.ops) || ops || [];
    document.body.classList.add('freestyle-on');
    btn.setAttribute('aria-pressed', 'true');
    panel.hidden = false;
    $('fsOriginal').checked = false;
    window.SBS.freestyleLayout(true, false);
    setInfo(null);
    attach();
  }

  function close() {
    if (ops.length && !confirm('Leave Freestyle? Your ' + ops.length + ' change' + (ops.length > 1 ? 's' : '') + ' will be lost unless you copied the link.')) return;
    on = false;
    if (editor) { try { editor.stop(); } catch (e) { /* page may have gone */ } }
    editor = null;
    ops = [];
    document.body.classList.remove('freestyle-on');
    btn.setAttribute('aria-pressed', 'false');
    panel.hidden = true;
    window.SBS.freestyleLayout(false);
  }

  btn.addEventListener('click', function () { if (on) close(); else open(null); });
  $('fsClose').addEventListener('click', close);

  panel.querySelectorAll('[data-add]').forEach(function (b) {
    b.addEventListener('click', function () {
      if (!editor) return;
      var text = $('fsText').value.trim();
      var kind = b.dataset.add;
      if (!editor.add(kind, kind === 'image' ? (text || 'Image') : (text || (kind === 'button' ? 'Button' : 'New text')))) {
        toast('Select an element on the page first');
      }
    });
  });
  $('fsUndo').addEventListener('click', function () { if (editor) editor.undo(); });
  $('fsRedo').addEventListener('click', function () { if (editor) editor.redo(); });
  $('fsReset').addEventListener('click', function () {
    if (editor && confirm('Undo all ' + ops.length + ' changes?')) editor.reset();
  });
  $('fsOriginal').addEventListener('change', function () {
    window.SBS.freestyleLayout(true, $('fsOriginal').checked);
  });

  // Screenshots reuse the Annotate capture; hide the editor's outlines meanwhile.
  window.addEventListener('sbs:capture-start', function () { if (editor) editor.setCapturing(true); });
  window.addEventListener('sbs:capture-end', function () { if (editor) editor.setCapturing(false); });
  $('fsShot').addEventListener('click', function () { $('captureBtn').click(); });

  $('fsLink').addEventListener('click', function () {
    window.SBS.shareUrl().then(function (url) {
      return navigator.clipboard.writeText(url).then(function () {
        toast(ops.length ? 'Link copied with ' + ops.length + ' change' + (ops.length > 1 ? 's' : '') : 'Link copied');
      });
    }).catch(function () { toast('Couldn’t copy the link'); });
  });

  window.SBS = window.SBS || {};
  window.SBS.freestyle = {
    save: function () { return on ? { v: 1, ops: ops } : null; },
    open: function (data) { if (data && data.v === 1) open(data); },
    isOn: function () { return on; },
  };
})();
