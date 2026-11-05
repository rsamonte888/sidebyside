// Figma frame picker: shows every screen (section) under a Figma link with
// Desktop / Tablet / Mobile thumbnails. Clicking one loads it side by side.
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var dialog = $('picker');
  var body = $('pickerBody');
  var title = $('pickerTitle');
  var search = $('pickerSearch');
  var backBtn = $('pickerBack');
  var refreshBtn = $('pickerRefresh');

  var state = { link: null, data: null, onPick: null, current: null, pagesLink: null };
  var LABEL = { desktop: 'Desktop', tablet: 'Tablet', mobile: 'Mobile' };

  // --- small caches (best effort) --------------------------------------------
  function cacheGet(store, k, maxAge) {
    try {
      var v = JSON.parse(store.getItem(k));
      return v && Date.now() - v.t < maxAge ? v.d : null;
    } catch (e) { return null; }
  }
  function cacheSet(store, k, d) {
    try { store.setItem(k, JSON.stringify({ t: Date.now(), d: d })); } catch (e) { /* full or blocked */ }
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }

  function getJson(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) {
          var e = new Error(j.error || 'Something went wrong (' + r.status + ').');
          e.status = r.status;
          e.retryAfter = Number(r.headers.get('retry-after')) || 0;
          throw e;
        }
        return j;
      });
    });
  }

  function loadTree(link, fresh) {
    var key = 'sbs:tree:' + link;
    var cached = !fresh && cacheGet(sessionStorage, key, 10 * 60 * 1000);
    if (cached) return Promise.resolve(cached);
    return getJson('/__sbs/figma/tree?url=' + encodeURIComponent(link)).then(function (d) {
      cacheSet(sessionStorage, key, d);
      return d;
    });
  }

  // --- thumbnails: fetched in small batches as cards scroll into view ---------
  var queue = [];
  var active = 0;
  var pausedUntil = 0;

  function thumbKey(fileKey, id) { return 'sbs:th:' + fileKey + ':' + id; }

  function requestThumbs(fileKey, imgs) {
    imgs.forEach(function (img) {
      var hit = cacheGet(localStorage, thumbKey(fileKey, img.dataset.id), 2 * 24 * 3600 * 1000);
      if (hit) setThumb(img, hit);
      else queue.push({ key: fileKey, img: img });
    });
    pump();
  }

  function setThumb(img, url) {
    img.src = url;
    img.closest('.pk-tile').classList.remove('loading');
  }

  function pump() {
    if (active >= 2 || !queue.length) return;
    var wait = pausedUntil - Date.now();
    if (wait > 0) { setTimeout(pump, wait); return; }
    var key = queue[0].key;
    var batch = [];
    while (queue.length && batch.length < 12 && queue[0].key === key) batch.push(queue.shift());
    var ids = batch.map(function (b) { return b.img.dataset.id; });
    active++;
    getJson('/__sbs/figma/thumbs?key=' + encodeURIComponent(key) + '&ids=' + encodeURIComponent(ids.join(',')))
      .then(function (d) {
        batch.forEach(function (b) {
          var url = d.images && d.images[b.img.dataset.id];
          if (url) { cacheSet(localStorage, thumbKey(key, b.img.dataset.id), url); setThumb(b.img, url); }
          else b.img.closest('.pk-tile').classList.add('nothumb');
        });
      })
      .catch(function (e) {
        if (e.status === 429) {
          // Figma is rate limiting: put them back and wait.
          pausedUntil = Date.now() + Math.min(30, e.retryAfter || 10) * 1000;
          queue = batch.concat(queue);
        } else {
          batch.forEach(function (b) { b.img.closest('.pk-tile').classList.add('nothumb'); });
        }
      })
      .then(function () { active--; pump(); });
    pump();
  }

  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (!en.isIntersecting) return;
      observer.unobserve(en.target);
      requestThumbs(en.target.dataset.key, Array.prototype.slice.call(en.target.querySelectorAll('img[data-id]')));
    });
  }, { root: body, rootMargin: '300px' });

  // --- rendering --------------------------------------------------------------
  function message(html) { body.innerHTML = '<div class="pk-msg">' + html + '</div>'; }

  function renderPages(d) {
    title.textContent = d.file || 'Figma file';
    search.hidden = true;
    var html = '<div class="pk-pages"><p class="pk-hint">Pick a page:</p>';
    d.pages.forEach(function (p) {
      html += '<button type="button" class="pk-page" data-page="' + esc(p.id) + '">' + esc(p.name.replace(/^↳\s*/, '')) + '</button>';
    });
    body.innerHTML = html + '</div>';
    body.querySelectorAll('[data-page]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.pagesLink = state.link;
        show(withNode(state.link, b.dataset.page));
      });
    });
  }

  function renderGroups(d) {
    title.textContent = d.root ? d.root.name : d.file;
    search.hidden = false;
    if (!d.groups.length) {
      message('No screens found here. Try a link to a section or page that contains your Desktop / Tablet / Mobile frames.');
      return;
    }
    var html = '';
    d.groups.forEach(function (g, gi) {
      var where = g.trail.length ? '<span class="pk-trail">' + esc(g.trail.join(' › ')) + ' › </span>' : '';
      html += '<section class="pk-group" data-g="' + gi + '" data-key="' + esc(d.key) + '" data-text="' +
        esc((g.trail.join(' ') + ' ' + g.name + ' ' + g.frames.map(function (f) { return f.name; }).join(' ')).toLowerCase()) + '">' +
        '<h3>' + where + esc(g.name) + '</h3><div class="pk-frames">';
      g.frames.forEach(function (f, fi) {
        var cur = state.current === f.id ? ' current' : '';
        html += '<button type="button" class="pk-tile loading ' + f.device + cur + '" data-g="' + gi + '" data-f="' + fi + '" title="' + esc(f.name) + '">' +
          '<span class="pk-thumb"><img alt="" data-id="' + esc(f.id) + '"></span>' +
          '<span class="pk-cap"><b>' + LABEL[f.device] + '</b> ' + f.w + '<br><small>' + esc(f.name) + '</small></span></button>';
      });
      html += '</div></section>';
    });
    body.innerHTML = html;
    body.querySelectorAll('.pk-group').forEach(function (s) { observer.observe(s); });
    body.querySelectorAll('.pk-tile').forEach(function (t) {
      t.addEventListener('click', function () {
        var g = d.groups[+t.dataset.g];
        var f = g.frames[+t.dataset.f];
        dialog.close();
        if (state.onPick) state.onPick({ key: d.key, group: g, frame: f });
      });
    });
    filter();
    var cur = body.querySelector('.pk-tile.current');
    if (cur) cur.scrollIntoView({ block: 'center' });
  }

  function filter() {
    var q = search.value.trim().toLowerCase();
    body.querySelectorAll('.pk-group').forEach(function (s) {
      s.hidden = q && s.dataset.text.indexOf(q) < 0;
    });
  }
  search.addEventListener('input', filter);

  function withNode(link, nodeId) {
    var u = new URL(link);
    u.searchParams.set('node-id', nodeId.replace(':', '-'));
    return u.toString();
  }

  function show(link, fresh) {
    state.link = link;
    backBtn.hidden = !state.pagesLink || state.pagesLink === link;
    search.value = '';
    queue = [];
    if (!dialog.open) dialog.showModal();
    message('Reading the Figma file… <span class="pk-spin"></span>');
    return loadTree(link, fresh).then(function (d) {
      if (state.link !== link) return;
      state.data = d;
      if (d.pages) renderPages(d); else renderGroups(d);
    }).catch(function (e) {
      message('<b>Couldn’t read the Figma file.</b><br>' + esc(e.message));
    });
  }

  backBtn.addEventListener('click', function () { if (state.pagesLink) { var l = state.pagesLink; state.pagesLink = null; show(l); } });
  refreshBtn.addEventListener('click', function () { if (state.link) show(state.link, true); });
  $('pickerClose').addEventListener('click', function () { dialog.close(); });

  window.SBS = window.SBS || {};
  window.SBS.picker = {
    /**
     * Show the screens under `link`. Calls onPick({ key, group, frame }).
     * A link to a single frame is picked straight away without showing the picker.
     */
    open: function (link, onPick, opts) {
      opts = opts || {};
      state.onPick = onPick;
      state.current = opts.current || null;
      state.pagesLink = null;
      if (opts.auto) {
        return loadTree(link).then(function (d) {
          if (d.groups && d.groups.length === 1 && d.groups[0].frames.length === 1) {
            onPick({ key: d.key, group: d.groups[0], frame: d.groups[0].frames[0] });
            return;
          }
          show(link);
        }).catch(function () { show(link); });
      }
      return show(link);
    },
  };
})();
