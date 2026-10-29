#!/usr/bin/env node
/**
 * Bodrless widget upgrade: map, visual cards, lively replies.
 * Usage:  node upgrade-widget.js path/to/widget.js
 * Makes widget.js.bak first, aborts without writing if any anchor is not found.
 */
const fs = require('fs');
const file = process.argv[2];
if (!file) { console.error('Usage: node upgrade-widget.js <path-to-widget-route.js>'); process.exit(1); }

let src = fs.readFileSync(file, 'utf8');
if (src.includes('BODRLESS VISUAL UPGRADE')) { console.error('Already applied. Nothing to do.'); process.exit(0); }

// whitespace-tolerant exact-token matcher
const loose = (s) => new RegExp(s.trim().split(/\s+/).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'), 'g');

const CSS_BLOCK = String.raw`
/* ── BODRLESS VISUAL UPGRADE: css ── */
.et-trip-head{border-radius:16px;padding:16px 16px 14px;color:#fff;margin:2px 0 10px;background:linear-gradient(135deg,var(--et-navy) 0%,#2d3f82 60%,var(--et-gold) 170%);position:relative;overflow:hidden;animation:et-rise .4s var(--et-ease) both;}
.et-trip-head::after{content:"";position:absolute;right:-30px;top:-34px;width:140px;height:140px;border-radius:50%;background:rgba(255,255,255,.08);}
.et-trip-eyebrow{font-size:10px;letter-spacing:2px;text-transform:uppercase;opacity:.75;margin-bottom:6px;font-weight:600;}
.et-trip-title{font-size:21px;font-weight:700;letter-spacing:-.02em;line-height:1.2;margin-bottom:10px;position:relative;z-index:1;}
.et-trip-chips{display:flex;flex-wrap:wrap;gap:6px;position:relative;z-index:1;}
.et-trip-chip{background:rgba(255,255,255,.16);border-radius:20px;padding:4px 10px;font-size:11px;font-weight:600;}
.et-hero-img{position:relative;height:150px;background:linear-gradient(135deg,var(--et-navy),#2d3f82);border-radius:14px 14px 0 0;overflow:hidden;}
.et-hero-img img{position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;}
.et-hero-img::after{content:"";position:absolute;top:0;left:0;right:0;bottom:0;background:linear-gradient(180deg,rgba(0,0,0,0) 35%,rgba(0,0,0,.62) 100%);pointer-events:none;}
.et-hero-cap{position:absolute;left:12px;right:96px;bottom:10px;z-index:2;color:#fff;font-weight:700;font-size:14px;line-height:1.25;text-shadow:0 1px 6px rgba(0,0,0,.45);}
.et-hero-cap small{display:block;font-weight:500;font-size:11px;opacity:.9;margin-top:2px;}
.et-badge{position:absolute;top:10px;left:10px;z-index:2;background:var(--et-gold);color:#fff;font-size:10px;font-weight:700;letter-spacing:.4px;padding:4px 9px;border-radius:20px;text-transform:uppercase;box-shadow:0 2px 8px rgba(0,0,0,.25);}
.et-pin-btn{position:absolute;right:10px;bottom:10px;z-index:2;background:rgba(255,255,255,.96);color:#1B2240;border:none;border-radius:20px;padding:6px 11px;font:600 11px Inter,Arial,sans-serif;cursor:pointer;}
.package.has-hero .pkg-header{border-radius:0;}
.package.et-flash{box-shadow:0 0 0 3px var(--et-gold),0 10px 28px rgba(27,34,64,.14);}
.et-map{border:1px solid var(--et-border);border-radius:14px;overflow:hidden;margin-bottom:10px;background:var(--et-white);position:relative;z-index:0;isolation:isolate;animation:et-rise .38s var(--et-ease) both;}
.et-map-bar{display:flex;align-items:center;justify-content:space-between;padding:9px 12px;font-size:12px;font-weight:600;color:var(--et-ink);}
.et-map-bar small{color:var(--et-muted);font-weight:500;margin-left:6px;}
.et-map-toggle{background:none;border:none;color:var(--et-gold);font:600 11px Inter,Arial,sans-serif;cursor:pointer;}
.et-map-canvas{height:190px;transition:height .3s var(--et-ease);background:var(--et-cream);}
.et-map.big .et-map-canvas{height:340px;}
.et-map .leaflet-container{font-family:Inter,Arial,sans-serif;}
.et-pin{background:none;border:none;}
.et-pin span{position:absolute;transform:translate(-50%,-100%);background:var(--et-navy);color:#fff;font:700 11px Inter,Arial,sans-serif;padding:5px 9px;border-radius:14px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.3);border:2px solid #fff;cursor:pointer;transition:transform .15s,background .15s;}
.et-pin.active span{background:var(--et-gold);transform:translate(-50%,-100%) scale(1.14);}
.et-pin.dot span{width:12px;height:12px;padding:0;border-radius:50%;transform:translate(-50%,-50%);background:var(--et-gold);cursor:default;}
.et-pin.dest span{background:var(--et-gold);}
.dark .leaflet-tile-pane{filter:invert(1) hue-rotate(180deg) brightness(.95) contrast(.9);}
.et-quick{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 6px;}
.et-quick button{background:var(--et-white);border:1px solid var(--et-border);color:var(--et-ink);border-radius:20px;padding:7px 12px;font:500 12px Inter,Arial,sans-serif;cursor:pointer;animation:et-rise .4s var(--et-ease) both;}
.et-quick button:hover{border-color:var(--et-gold);}
`;

const JS_BLOCK = String.raw`
  // ── BODRLESS VISUAL UPGRADE: map, visual cards, lively replies ────────────
  var LEAFLET_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
  var LEAFLET_JS  = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
  var TILE_URL    = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

  // City-centre fallbacks so the map works even when a supplier sends no coordinates.
  var GEO = {
    "nairobi":[-1.2864,36.8172], "nbo":[-1.3192,36.9275], "wilson":[-1.3219,36.8148], "wil":[-1.3219,36.8148],
    "mombasa":[-4.0435,39.6682], "mba":[-4.0348,39.5942],
    "diani":[-4.3151,39.5712], "ukunda":[-4.2933,39.5711], "uka":[-4.2933,39.5711],
    "malindi":[-3.2192,40.1169], "myd":[-3.2293,40.1017], "lamu":[-2.2717,40.9020], "lau":[-2.2524,40.9131],
    "kisumu":[-0.0917,34.7680], "kis":[-0.0861,34.7289], "nanyuki":[0.0167,37.0722],
    "naivasha":[-0.7172,36.4310], "nakuru":[-0.3031,36.0800], "amboseli":[-2.6527,37.2606],
    "masai mara":[-1.4061,35.0087], "maasai mara":[-1.4061,35.0087], "mara":[-1.4061,35.0087], "mre":[-1.4061,35.0087],
    "zanzibar":[-6.1659,39.2026], "znz":[-6.2220,39.2249],
    "dar es salaam":[-6.7924,39.2083], "dar":[-6.7924,39.2083], "dar es salaam airport":[-6.8781,39.2026],
    "arusha":[-3.3869,36.6830], "kilimanjaro":[-3.4294,37.0745], "jro":[-3.4294,37.0745],
    "serengeti":[-2.3333,34.8333], "ngorongoro":[-3.2000,35.5000],
    "kigali":[-1.9441,30.0619], "kgl":[-1.9686,30.1395], "kampala":[0.3476,32.5825],
    "entebbe":[0.0424,32.4435], "ebb":[0.0424,32.4435], "addis ababa":[9.0300,38.7400], "add":[8.9779,38.7993],
    "cape town":[-33.9249,18.4241], "cpt":[-33.9715,18.6021], "johannesburg":[-26.2041,28.0473], "jnb":[-26.1337,28.2420],
    "victoria falls":[-17.9243,25.8572], "vfa":[-18.0959,25.8390], "accra":[5.6037,-0.1870], "lagos":[6.5244,3.3792],
    "dubai":[25.2048,55.2708], "dxb":[25.2532,55.3657], "london":[51.5074,-0.1278], "lhr":[51.4700,-0.4543]
  };
  var _leafletQ = null;

  function _geo(name) {
    if (!name) return null;
    var k = String(name).toLowerCase().replace(/[^a-z ]/g, " ").replace(/ +/g, " ").trim();
    if (!k) return null;
    if (GEO[k]) return GEO[k];
    var keys = Object.keys(GEO);
    for (var i = 0; i < keys.length; i++) { if (keys[i].length > 3 && k.indexOf(keys[i]) !== -1) return GEO[keys[i]]; }
    return null;
  }

  function _num(v) { var n = parseFloat(v); return isFinite(n) ? n : null; }
  function _hotelLL(h) {
    if (!h) return null;
    var c = h.coordinates || h.coords || h.geo || (h.location && typeof h.location === "object" ? h.location : null) || {};
    var lat = _num(h.latitude != null ? h.latitude : h.lat != null ? h.lat : c.latitude != null ? c.latitude : c.lat);
    var lng = _num(h.longitude != null ? h.longitude : h.lng != null ? h.lng : h.lon != null ? h.lon : c.longitude != null ? c.longitude : c.lng != null ? c.lng : c.lon);
    if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null;
    return [lat, lng];
  }

  function _loadLeaflet(ok, fail) {
    if (window.L && window.L.map) { ok(); return; }
    if (_leafletQ) { _leafletQ.push([ok, fail]); return; }
    _leafletQ = [[ok, fail]];
    var css = document.createElement("link"); css.rel = "stylesheet"; css.href = LEAFLET_CSS; document.head.appendChild(css);
    var s = document.createElement("script"); s.src = LEAFLET_JS;
    s.onload  = function () { var q = _leafletQ; _leafletQ = null; q.forEach(function (x) { x[0](); }); };
    s.onerror = function () { var q = _leafletQ; _leafletQ = null; q.forEach(function (x) { if (x[1]) x[1](); }); };
    document.head.appendChild(s);
  }

  function _arc(a, b) {
    var mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, dLat = b[0] - a[0], dLng = b[1] - a[1];
    var c = [mx - dLng * 0.2, my + dLat * 0.2], pts = [];
    for (var i = 0; i <= 24; i++) {
      var t = i / 24, u = 1 - t;
      pts.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]);
    }
    return pts;
  }

  function _shortPrice(n, cur) {
    n = Math.round(Number(n) || 0);
    return (cur || "KES") + " " + (n >= 10000 ? Math.round(n / 1000) + "k" : n >= 1000 ? (n / 1000).toFixed(1).replace(".0", "") + "k" : n);
  }

  function _collectGeo(shown, tp) {
    var t0 = null, i;
    for (i = 0; i < shown.length; i++) { if (shown[i].transport) { t0 = shown[i].transport; break; } }
    var destName = (tp && tp.destination) || (t0 && t0.destination) || "";
    var geo = { destName: destName, origin: _geo(t0 && t0.originIata) || _geo(t0 && t0.origin), dest: _geo(destName) || _geo(t0 && t0.destIata) || _geo(t0 && t0.destination), pins: [] };
    for (i = 0; i < shown.length; i++) {
      var ll = _hotelLL(shown[i].hotel);
      if (ll) geo.pins.push({ i: i, ll: ll, label: _shortPrice(shown[i].hotel.pricePerNight || (shown[i].summary && shown[i].summary.totalPrice), shown[i].hotel.currency || (shown[i].summary && shown[i].summary.currency)) });
    }
    return geo;
  }

  function _buildMapShell(shown, tp) {
    var geo = _collectGeo(shown, tp);
    if (!geo.pins.length && !geo.dest) return null;
    var shell = document.createElement("div"); shell.className = "et-map"; shell._geo = geo;
    var bar = document.createElement("div"); bar.className = "et-map-bar";
    var ttl = document.createElement("span");
    ttl.innerHTML = "&#128506;&#65039; " + (geo.destName ? titleCase(geo.destName) : "Your trip");
    var hint = document.createElement("small"); hint.innerText = geo.pins.length ? "tap a price to jump to it" : "";
    ttl.appendChild(hint);
    var tg = document.createElement("button"); tg.className = "et-map-toggle"; tg.type = "button"; tg.innerText = "Expand";
    bar.appendChild(ttl); bar.appendChild(tg);
    var canvas = document.createElement("div"); canvas.className = "et-map-canvas";
    shell.appendChild(bar); shell.appendChild(canvas); shell._toggle = tg;
    return shell;
  }

  function _initMap(shell, shown, cards) {
    var geo = shell._geo;
    _loadLeaflet(function () {
      var L = window.L, canvas = shell.querySelector(".et-map-canvas");
      var gold = (getComputedStyle(root).getPropertyValue("--et-gold") || "").trim() || "#B8964A";
      var map = L.map(canvas, { scrollWheelZoom: false, tap: false, zoomControl: true });
      L.tileLayer(TILE_URL, { maxZoom: 18, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
      var pts = [], markers = {};
      function mk(ll, cls, html) { return L.marker(ll, { icon: L.divIcon({ className: "et-pin " + cls, html: "<span>" + html + "</span>", iconSize: [0, 0] }) }).addTo(map); }
      function setActive(idx) {
        Object.keys(markers).forEach(function (k) { var el = markers[k].getElement(); if (el) el.classList.toggle("active", String(k) === String(idx)); });
      }
      function focusCard(idx) {
        var c = cards[idx]; if (!c) return;
        c.scrollIntoView({ behavior: "smooth", block: "center" });
        c.classList.add("et-flash"); setTimeout(function () { c.classList.remove("et-flash"); }, 1500);
      }
      if (geo.origin && geo.dest) {
        mk(geo.origin, "dot", "");
        L.polyline(_arc(geo.origin, geo.dest), { color: gold, weight: 2, opacity: 0.85, dashArray: "6 8" }).addTo(map);
        pts.push(geo.origin);
      }
      if (geo.pins.length) {
        geo.pins.forEach(function (p) {
          var m = mk(p.ll, "", p.label); markers[p.i] = m; pts.push(p.ll);
          m.on("click", function () { setActive(p.i); focusCard(p.i); });
          var c = cards[p.i];
          if (c) { c._showOnMap = function () { map.flyTo(p.ll, Math.max(map.getZoom(), 12), { duration: 0.6 }); setActive(p.i); shell.scrollIntoView({ behavior: "smooth", block: "nearest" }); };
                   if (c._pinBtn) c._pinBtn.style.display = ""; }
        });
      } else if (geo.dest) {
        mk(geo.dest, "dest", titleCase(geo.destName || "Destination")); pts.push(geo.dest);
        cards.forEach(function (c) { if (c._pinBtn) { c._pinBtn.style.display = ""; c._showOnMap = function () { map.flyTo(geo.dest, 9, { duration: 0.6 }); shell.scrollIntoView({ behavior: "smooth", block: "nearest" }); }; } });
      }
      if (pts.length > 1) map.fitBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 12 }); else map.setView(pts[0], geo.pins.length ? 12 : 9);
      var mobile = L.Browser.mobile; if (mobile) map.dragging.disable();
      shell._toggle.onclick = function () {
        var big = shell.classList.toggle("big");
        shell._toggle.innerText = big ? "Collapse" : "Expand";
        if (mobile) { if (big) map.dragging.enable(); else map.dragging.disable(); }
        setTimeout(function () { map.invalidateSize(); if (pts.length > 1) map.fitBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 12 }); }, 320);
      };
      setTimeout(function () { map.invalidateSize(); }, 450);
    }, function () { shell.remove(); });
  }

  function _badgesFor(shown) {
    var b = {}, cheapest = 0, i;
    for (i = 1; i < shown.length; i++) {
      var a = shown[i].summary && shown[i].summary.totalPrice, c = shown[cheapest].summary && shown[cheapest].summary.totalPrice;
      if (a && c && a < c) cheapest = i;
    }
    if (shown.length > 1 && cheapest !== 0) { b[0] = "Top pick"; b[cheapest] = "Best price"; }
    else b[0] = shown.length > 1 ? "Top pick \u00b7 Best price" : "Top pick";
    return b;
  }

  function _decorateCard(card, p, i, badge) {
    var h = p.hotel || null, t = p.transport || null;
    if (!h && !t) return;
    var src = h && h.images && h.images[0] ? String(h.images[0]) : "";
    var hero = document.createElement("div"); hero.className = "et-hero-img";
    if (src.indexOf("http") === 0) {
      var im = document.createElement("img"); im.src = src; im.alt = (h && h.name) || "Stay"; im.loading = "lazy";
      im.onerror = function () { im.remove(); }; hero.appendChild(im);
      var old = card.querySelector(".pkg-body img"); if (old) old.remove();
    }
    var cap = document.createElement("div"); cap.className = "et-hero-cap";
    if (h) {
      var stars = h.stars ? Array(Math.min(Math.round(h.stars), 5) + 1).join("\u2605") : "";
      cap.innerText = (h.name || "Your stay") + (stars ? "  " + stars : "");
      var sm = document.createElement("small"); sm.innerText = h.location || ""; cap.appendChild(sm);
    } else {
      cap.innerText = (t.origin || "") + " \u2192 " + (t.destination || "");
      var sm2 = document.createElement("small"); sm2.innerText = t.airline || t.provider || ""; cap.appendChild(sm2);
    }
    hero.appendChild(cap);
    if (badge) { var bd = document.createElement("div"); bd.className = "et-badge"; bd.innerText = badge; hero.appendChild(bd); }
    var pb = document.createElement("button"); pb.type = "button"; pb.className = "et-pin-btn"; pb.innerHTML = "&#128205; Map"; pb.style.display = "none";
    pb.onclick = function () { if (card._showOnMap) card._showOnMap(); };
    hero.appendChild(pb); card._pinBtn = pb;
    card.insertBefore(hero, card.firstChild); card.classList.add("has-hero");
  }

  function _tripHeader(tp, shown) {
    var t0 = shown[0] && shown[0].transport;
    var dest = tp && tp.destination ? titleCase(tp.destination) : (t0 && t0.destination) || "";
    if (!dest) return null;
    var s = shown[0].summary || {}, cur = s.currency || "KES";
    var nights = s.nights || 0, pax = s.passengers || (tp && tp.passengers) || 1, min = 0;
    shown.forEach(function (x) { var v = x.summary && x.summary.totalPrice; if (v && (!min || v < min)) min = v; });
    var d = document.createElement("div"); d.className = "et-trip-head";
    var e = document.createElement("div"); e.className = "et-trip-eyebrow"; e.innerText = guestName ? "Picked for " + guestName : "Your trip";
    var t = document.createElement("div"); t.className = "et-trip-title"; t.innerText = dest;
    var chips = document.createElement("div"); chips.className = "et-trip-chips";
    function chip(txt) { var c = document.createElement("span"); c.className = "et-trip-chip"; c.innerText = txt; chips.appendChild(c); }
    if (nights > 0) chip(nights + (nights === 1 ? " night" : " nights"));
    chip(pax + (Number(pax) === 1 ? " traveller" : " travellers"));
    if (min) chip("From " + cur + " " + Math.round(min).toLocaleString());
    d.appendChild(e); d.appendChild(t); d.appendChild(chips);
    return d;
  }

  function _clearQuick() { var q = messages.querySelectorAll(".et-quick"); for (var i = 0; i < q.length; i++) q[i].remove(); }
  function _showQuick() {
    _clearQuick();
    var wrap = document.createElement("div"); wrap.className = "et-quick";
    ["Something cheaper", "More nights", "Upgrade the hotel", "Different dates"].forEach(function (txt, i) {
      var b = document.createElement("button"); b.type = "button"; b.innerText = txt; b.style.animationDelay = (700 + i * 70) + "ms";
      b.onclick = function () { input.value = txt; send(); };
      wrap.appendChild(b);
    });
    messages.appendChild(wrap);
  }

  function renderResults(shown, tp, afterEl) {
    if (!shown || !shown.length) return;
    var base = afterEl && afterEl.dataset && afterEl.dataset.typeMs ? Number(afterEl.dataset.typeMs) : 0;
    var head = _tripHeader(tp, shown); if (head) { head.style.animationDelay = base + "ms"; messages.appendChild(head); }
    var shell = _buildMapShell(shown, tp); if (shell) { shell.style.animationDelay = (base + 80) + "ms"; messages.appendChild(shell); }
    var badges = _badgesFor(shown), cards = [];
    shown.forEach(function (p, i) {
      var card = addPackage(p, i, null, null);
      _decorateCard(card, p, i, badges[i]);
      card.style.animationDelay = (base + 160 + i * 90) + "ms";
      messages.appendChild(card); cards.push(card);
    });
    if (shell) _initMap(shell, shown, cards);
    _showQuick();
  }

  // ── lively wording ──
  var _lastWarm = "";
  function _fresh(arr) {
    var s, tries = 0;
    do { s = arr[Math.floor(Math.random() * arr.length)]; tries++; } while (s === _lastWarm && tries < 6);
    _lastWarm = s; return s;
  }
  var FLAT_OPEN = /^\\s*(got it|sure thing|sure|okay|ok|alright|certainly|understood|noted|of course)\\b[\\s.,!:;-]*/i;

  function _warmOpener(tp) {
    var dest = tp && tp.destination ? titleCase(tp.destination) : "";
    var pax  = tp && Number(tp.passengers) ? Number(tp.passengers) : 1;
    var prefs = tp && Array.isArray(tp.preferences) ? tp.preferences.join(" ").toLowerCase() : "";
    var nm = guestName ? guestName + ", " : "";
    if (/honeymoon|romantic|anniversary|babymoon/.test(prefs)) {
      return _fresh([
        "Leave this one with me, " + (guestName || "I've got you") + ". Let's make it unforgettable.",
        "A romantic getaway" + (dest ? " to " + dest : "") + "? Let me take care of you both.",
        "Oh, I love this. Let's find you something truly special."
      ]);
    }
    if (pax >= 3 || /family|kids|child|children/.test(prefs)) {
      return _fresh([
        "Family trip" + (dest ? " to " + dest : "") + "! Let me take care of the details so you can relax.",
        nm + "leave it with me. I'll find something the whole crew will love.",
        "Let's find you something great for everyone."
      ]);
    }
    if (dest) {
      return _fresh([
        "Let me take care of this for you. " + dest + " is a great choice.",
        nm + "leave it with me. Here's what I found for " + dest + ".",
        "Let's find you something good in " + dest + ".",
        dest + ", lovely. I've lined up some options for you."
      ]);
    }
    return _fresh([
      "Let me take care of this for you.",
      nm + "leave it with me. I've found some good ones.",
      "Let's find you something great. Here's what I've got."
    ]);
  }

  function warmen(text, tp, n) {
    var t = String(text || "").trim();
    if (!t) {
      return n > 0 ? _fresh(["Here's what I'd pick for you. The first one is my favourite.", "Found some good ones for you. Start with the first.", "These are the ones I'd look at first."]) : "";
    }
    var m = FLAT_OPEN.exec(t);
    if (!m) return t;
    var rest = t.slice(m[0].length).trim();
    if (rest) rest = rest.charAt(0).toUpperCase() + rest.slice(1);
    if (n === 0) return rest || t;
    var open = _warmOpener(tp);
    return rest ? open + " " + rest : open;
  }

  function _ackLine(txt) {
    var s = String(txt || ""), dest = "", m, k;
    var stop = " the a an my our your me us for in on from with next this to visit visiting go going fly flying see travel travelling book plan find take get want need trip holiday vacation ";
    var res = [/\\bvisit(?:ing)?\\s+([a-z]+)(?:\\s+([a-z]+))?/i, /\\bto\\s+([a-z]+)(?:\\s+([a-z]+))?/i, /\\bin\\s+([a-z]+)(?:\\s+([a-z]+))?/i];
    for (k = 0; k < res.length && !dest; k++) {
      m = res[k].exec(s);
      if (m && stop.indexOf(" " + m[1].toLowerCase() + " ") === -1) {
        dest = m[1];
        if (m[2] && stop.indexOf(" " + m[2].toLowerCase() + " ") === -1 && !/^(day|days|night|nights|week|weeks|adult|adults|people|person|kids|child|children|january|february|march|april|may|june|july|august|september|october|november|december)$/i.test(m[2])) dest += " " + m[2];
        dest = titleCase(dest);
      }
    }
    if (dest) return _fresh(["Leave it with me. Finding you something special in " + dest + "\u2026", "Let's find you something great in " + dest + "\u2026", "On it. Pulling the best of " + dest + " together for you\u2026"]);
    return _fresh(["Let me take care of this for you\u2026", "Let's find you something good\u2026", "Leave it with me, I'm on it\u2026"]);
  }

  function addMsgTyped(text, type) {
    var div = document.createElement("div"); div.className = "msg " + type; messages.appendChild(div);
    var words = String(text).split(" ");
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || words.length > 60) { div.innerText = text; messages.scrollTop = messages.scrollHeight; return div; }
    div.dataset.typeMs = String(Math.min(words.length * 28, 1100));
    var i = 0;
    (function step() { i++; div.innerText = words.slice(0, i).join(" "); messages.scrollTop = messages.scrollHeight; if (i < words.length) setTimeout(step, 28); })();
    return div;
  }

  // Overrides the original showTyping (later function declarations win).
  var TYPING_STAGES = isHotelMode
    ? ["Checking availability\u2026", "Finding the best rooms for you\u2026", "Adding the finishing touches\u2026"]
    : ["Checking flights\u2026", "Finding stays you'll love\u2026", "Lining up transfers\u2026", "Pricing it all up\u2026", "Putting the finishing touches\u2026"];
  function showTyping(promptText) {
    if (_typingInterval) { clearInterval(_typingInterval); _typingInterval = null; }
    var old = document.getElementById("et-typing"); if (old) old.remove();
    var d = document.createElement("div"); d.className = "typing"; d.id = "et-typing";
    var dots = document.createElement("div"); dots.className = "typing-dots"; dots.innerHTML = "<span></span><span></span><span></span>";
    var label = document.createElement("div"); label.className = "typing-label"; label.id = "et-typing-label";
    var stages = promptText ? [_ackLine(promptText)].concat(TYPING_STAGES) : ["One moment\u2026"];
    var idx = 0; label.innerText = stages[0];
    d.appendChild(dots); d.appendChild(label);
    messages.appendChild(d); messages.scrollTop = messages.scrollHeight;
    if (stages.length > 1) {
      _typingInterval = setInterval(function () {
        if (idx >= stages.length - 1) return;
        idx++;
        var lbl = document.getElementById("et-typing-label");
        if (lbl) { lbl.style.opacity = "0"; setTimeout(function () { lbl.innerText = stages[idx]; lbl.style.opacity = "1"; }, 220); }
      }, 2600);
    }
  }
  // ── end BODRLESS VISUAL UPGRADE ──

  `;

const patches = [
  { name: 'CSS (append to styles)',
    find: '.dr-item small{color:var(--et-muted);}', rep: (m) => m + CSS_BLOCK },
  { name: 'JS helpers (insert before sendBtn.onclick)',
    find: 'sendBtn.onclick = send;', rep: (m) => JS_BLOCK + m },
  { name: 'send(): lively "thinking" label + clear old chips',
    find: "input.value='';showTyping();", rep: () => "input.value='';_clearQuick();showTyping(text);" },
  { name: 'results: warm opener text',
    find: "var rm3=data.text||'I found '+pkgs.length+' option(s) for you:';",
    rep: () => "var rm3=warmen(data.text,data.tripParams||previousParams,pkgs.length);" },
  { name: 'results: typed-out opener',
    find: "var botMsg3=addMsg(rm3,'bot');", rep: () => "var botMsg3=addMsgTyped(rm3,'bot');" },
  { name: 'results: header + map + hero cards + chips',
    find: "pkgs.slice(0,4).forEach(function(p,i){ var card = addPackage(p,i,null,null); messages.appendChild(card); });",
    rep: () => "renderResults(pkgs.slice(0,4),data.tripParams||previousParams,botMsg3);" },
  { name: 'clarification: drop flat openers',
    find: 'var ct=data.text||"Could you give me a bit more detail?";',
    rep: () => 'var ct=warmen(data.text||"Could you give me a bit more detail?",data.tripParams||previousParams,0);' },
  { name: 'no results: friendlier wording',
    find: 'var nt3=(data&&data.text)?data.text:"No options available.";',
    rep: () => 'var nt3=(data&&data.text)?data.text:"Hmm, nothing is coming up for those exact dates. Want me to try a day or two either side?";' },
  { name: 'error: friendlier wording',
    find: "addMsg('Unable to load options right now. Please try again.','bot');",
    rep: () => 'addMsg("Hmm, something hiccuped on my side. Give me a moment and try that again?",\'bot\');' },
  { name: 'agent-approved packages: same visual treatment',
    find: "(pd.packages || []).forEach(function(p, i) { var card = addPackage(p, i, null, null); messages.appendChild(card); });",
    rep: () => "renderResults(pd.packages || [], previousParams, null);" },
];

let out = src, failed = false;
for (const p of patches) {
  const re = loose(p.find);
  const hits = out.match(re) || [];
  if (hits.length !== 1) { console.error('✗ ' + p.name + ': expected 1 match, found ' + hits.length); failed = true; continue; }
  out = out.replace(re, (m) => p.rep(m));
  console.log('✓ ' + p.name);
}
if (failed) { console.error('\nNothing written. Send me the lines that failed and I will adjust the anchors.'); process.exit(1); }
fs.writeFileSync(file + '.bak', src);
fs.writeFileSync(file, out);
console.log('\nDone. Backup at ' + file + '.bak');