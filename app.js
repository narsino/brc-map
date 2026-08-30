/*
 * Black Rock City offline map.
 *
 * Everything is drawn in LOCAL METRES: +x east, +y north, origin at the Golden
 * Spike (the Man). The build step reprojects every coordinate into that frame,
 * so this file never touches latitude/longitude except in one place -- turning
 * the GPS reading into a position on the canvas (see toLocal()).
 *
 * Rendering is immediate-mode canvas: on any change we clear and redraw. The
 * whole city is ~1500 polylines, which is nothing; this keeps state trivial.
 */
(function () {
  "use strict";

  var D = window.BRC;                       // injected by the build
  var city = D.city, days = D.days, places = D.places;
  /* Images live in one table and records reference them by index, so a poster
     attached to both an event and its venue costs its bytes once. Index 0 is
     valid and falsy -- always test against undefined. */
  var media = D.media || [];
  /* An entry can carry several pictures -- a camp poster and the set-times
     flyer for the night you care about. Rows show the first; the detail pane
     shows them all. */
  function mediaSrcs(item) {
    if (!item || !item.imgs) return [];
    return item.imgs.map(function (i) { return media[i]; })
                    .filter(function (src) { return !!src; });
  }
  function mediaSrc(item) {
    var all = mediaSrcs(item);
    return all.length ? all[0] : null;
  }

  var canvas = document.getElementById("map");
  var sheet = document.getElementById("sheet");
  var ctx = canvas.getContext("2d");
  var dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  var VIEW_W = window.innerWidth, VIEW_H = window.innerHeight;

  // --- view state --------------------------------------------------------
  /* scale = screen pixels per metre. Set properly by fitCity() once we know how
     big the viewport actually is. */
  var view = { x: 0, y: 0, scale: 0.16 };
  var MIN_SCALE = 0.03, MAX_SCALE = 3.0;
  var fitted = false;

  var dayIndex = defaultDayIndex();
  var query = "";
  /* Three views, two buttons:
       "events"  the selected day's listings          (default)
       "agenda"  ★ — everything of yours, by time, across the whole week
       "places"  ☰ — the standing city, browsable without typing
     The split that makes this memorable: ☰ is WHERE things are, ★ is WHEN
     your things happen. Searching for a place you cannot name is a browse
     problem; finding out what you have on is a time problem. */
  var mode = "events";
  /* Which day the ★ agenda is narrowed to, or null for the whole week.
     Separate from `dayIndex` on purpose: narrowing the agenda must not move the
     day you were looking at in the normal view, or leaving ★ would dump you on
     a different day than the one you came from. */
  var agendaDay = null;
  var stars = loadStars();
  var selected = null;                       // currently highlighted item
  var gps = null;                            // {x, y, acc, sim} in local metres
  var follow = false;

  /* Diagnostics, driven by the query string. You cannot open a console on a
     phone, and "no blue dot" has at least five quite different causes, so the
     app has to be able to explain itself.

         ?sim=temple            fake a fix at a named landmark
         ?sim=40.788,-119.2015  fake a fix at explicit coordinates
         ?debug=1               show the geolocation diagnostic panel

     A simulated fix is drawn deliberately UNLIKE a real one -- amber, dashed,
     labelled SIMULATED, with a standing banner. A fake position that looked
     real would be actively dangerous to follow in the dark. */
  var params = new URLSearchParams(location.search);
  var simSpec = params.get("sim");
  var debugOn = params.has("debug") || !!simSpec;
  var diag = { lastError: null, lastFixAt: null, permission: "unknown",
               swState: "not registered", cachedCount: null, storage: "" };

  // --- projection --------------------------------------------------------
  var R = 6371008.8, DEG = Math.PI / 180;
  var spikeLat = city.spike[0], spikeLon = city.spike[1];
  var mPerLon = R * Math.cos(spikeLat * DEG) * DEG;

  function toLocal(lat, lon) {
    return { x: (lon - spikeLon) * mPerLon, y: (lat - spikeLat) * R * DEG };
  }
  function sx(x) { return (x - view.x) * view.scale + VIEW_W / 2; }
  function sy(y) { return VIEW_H / 2 - (y - view.y) * view.scale; }
  function unproject(px, py) {
    return {
      x: (px - VIEW_W / 2) / view.scale + view.x,
      y: (VIEW_H / 2 - py) / view.scale + view.y
    };
  }

  // --- drawing -----------------------------------------------------------
  function resize() {
    /* Measure the VIEWPORT, not the canvas. Reading back the element we are
       about to resize is how the feedback loop above starts. */
    var w = window.innerWidth, h = window.innerHeight;
    if (!w || !h) return;                    // laid out at zero; wait for the next tick
    VIEW_W = w; VIEW_H = h;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!fitted) { fitCity(); fitted = true; }
    draw();
  }

  /* Open on the whole city.

     Fit to the actual bounding box of the street network rather than to
     hand-tuned offsets -- the city is not centred on the Man (it is a horseshoe
     hanging south of him), so guessing a centre gets it wrong.

     The bottom of the screen is under the sheet, so we fit into the strip
     between the top bar and the top of the sheet, then solve for the view
     centre that puts the city's centre in the middle of THAT strip. */
  var cityBox = (function () {
    var b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (var i = 0; i < city.streets.length; i++) {
      var pts = city.streets[i].p;
      for (var j = 0; j < pts.length; j++) {
        if (pts[j][0] < b.x0) b.x0 = pts[j][0];
        if (pts[j][0] > b.x1) b.x1 = pts[j][0];
        if (pts[j][1] < b.y0) b.y0 = pts[j][1];
        if (pts[j][1] > b.y1) b.y1 = pts[j][1];
      }
    }
    return b;
  })();

  var TOP_CHROME_PX = 96;

  /* `plazas` and `streets` are records with a name attached; the generic shape
     helpers want bare point arrays. Unwrap the plazas once, up front. */
  var plazaShapes = city.plazas.map(function (z) { return z.p; });

  /* Searching only the day's events misses the most common question of all:
     "where is <camp>?" / "where is Center Camp?". Camps, art, landmarks and
     plazas are all fixed points, so index them once and search them alongside
     the listings. */
  /* True when the build carries real API listings, as opposed to only the
     handful of curated entries. Drives the empty-state wording. */
  var officialListings = days.some(function (d) {
    return d.events.some(function (e) { return !e.c; });
  });

  var placeIndex = (function () {
    var out = places.map(function (p) {
      return { id: p.id, t: p.t, a: p.a || "", k: p.k, x: p.x, y: p.y,
               d: p.d, imgs: p.imgs, place: 1 };
    });
    city.landmarks.forEach(function (m) {
      out.push({ id: "lm:" + m.n, t: m.n, a: "", k: "landmark",
                 x: m.p[0], y: m.p[1], place: 1 });
    });
    city.plazas.forEach(function (z, i) {
      if (!z.n) return;
      var cx = 0, cy = 0;
      z.p.forEach(function (pt) { cx += pt[0]; cy += pt[1]; });
      out.push({ id: "pz:" + i, t: z.n, a: "", k: "plaza",
                 x: Math.round(cx / z.p.length), y: Math.round(cy / z.p.length), place: 1 });
    });
    return out;
  })();

  /* Group order is "what am I most likely to want", not alphabetical: your own
     list first, then the fixed civic things you navigate by, then the long
     tail. */
  var PLACE_GROUPS = [
    { key: "curated",  label: "Your list" },
    { key: "venue",    label: "Event locations" },
    { key: "landmark", label: "Landmarks & services" },
    { key: "plaza",    label: "Plazas" },
    { key: "camp",     label: "Camps" },
    { key: "art",      label: "Art" },
  ];

  /* Your events, across the whole week rather than one day at a time. An
     event that runs on several days appears once per day, which is what you
     want -- "Tuesday's yoga" and "Thursday's yoga" are different plans. */
  function agendaEvents() {
    var q = query.trim().toLowerCase();
    var out = [];
    days.forEach(function (day, i) {
      if (agendaDay !== null && i !== agendaDay) return;
      day.events.forEach(function (e) {
        if (!isStarred(e)) return;   // yours by default; unstar to drop it
        if (q && (e.t + " " + (e.h || "") + " " + (e.a || "") + " " + (e.k || "") +
                  " " + ((e.ln || []).join(" ")))
                 .toLowerCase().indexOf(q) < 0) return;
        out.push({ event: e, dayLabel: day.label });
      });
    });
    out.sort(function (a, b) { return a.event.s < b.event.s ? -1 : a.event.s > b.event.s ? 1 : 0; });
    return out;
  }

  function allPlaces() {
    var q = query.trim().toLowerCase();
    return placeIndex.filter(function (p) {
      if (!q) return true;
      return (p.t + " " + (p.a || "")).toLowerCase().indexOf(q) >= 0;
    });
  }

  function groupPlaces(list) {
    var buckets = {};
    list.forEach(function (p) { (buckets[p.k] = buckets[p.k] || []).push(p); });
    var out = [];
    PLACE_GROUPS.forEach(function (g) {
      if (!buckets[g.key]) return;
      buckets[g.key].sort(function (a, b) { return a.t.localeCompare(b.t); });
      out.push({ label: g.label, items: buckets[g.key] });
      delete buckets[g.key];
    });
    Object.keys(buckets).sort().forEach(function (k) {   // any unexpected kind
      out.push({ label: k, items: buckets[k] });
    });
    return out;
  }

  function matchingPlaces() {
    var q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return placeIndex.filter(function (p) {
      return (p.t + " " + p.a).toLowerCase().indexOf(q) >= 0;
    }).slice(0, 40);
  }

  /* The map is only visible between the top bar and the top of the sheet.
     Everything that "centres" something must centre it in THAT strip, not in
     the canvas -- otherwise the thing you just tapped hides under the list. */
  function strip() {
    var sheetTop = sheet.classList.contains("down") ? VIEW_H - 46 : VIEW_H * 0.54;
    var top = TOP_CHROME_PX, bottom = Math.max(top + 80, sheetTop);
    return { top: top, bottom: bottom, height: bottom - top, centre: (top + bottom) / 2 };
  }

  /* Solve sy(y) == targetScreenY for view.y.  sy(y) = H/2 - (y - view.y)*scale */
  function centreOn(x, y) {
    view.x = x;
    view.y = y + (strip().centre - VIEW_H / 2) / view.scale;
  }

  function fitCity() {
    var W = VIEW_W;
    var stripH = strip().height;

    var padding = 0.92;
    view.scale = Math.max(MIN_SCALE, Math.min(
      (W * padding) / (cityBox.x1 - cityBox.x0),
      (stripH * padding) / (cityBox.y1 - cityBox.y0)
    ));

    centreOn((cityBox.x0 + cityBox.x1) / 2, (cityBox.y0 + cityBox.y1) / 2);
  }

  function path(points, close) {
    ctx.beginPath();
    ctx.moveTo(sx(points[0][0]), sy(points[0][1]));
    for (var i = 1; i < points.length; i++) ctx.lineTo(sx(points[i][0]), sy(points[i][1]));
    if (close) ctx.closePath();
  }

  function fillShapes(shapes, color, alpha) {
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.fillStyle = color;
    for (var i = 0; i < shapes.length; i++) {
      if (shapes[i].length < 3) continue;
      path(shapes[i], true);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function strokeShapes(shapes, color, width, dash) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash || []);
    for (var i = 0; i < shapes.length; i++) { path(shapes[i], false); ctx.stroke(); }
    ctx.setLineDash([]);
  }

  function draw() {
    var w = VIEW_W, h = VIEW_H;
    ctx.fillStyle = "#14110e";
    ctx.fillRect(0, 0, w, h);

    // Trash fence: the boundary of everything. Beyond it you are trespassing.
    fillShapes(city.fence, "#2a2118", 1);
    strokeShapes(city.fence, "#7a5c33", 1.5, [7, 5]);

    // Deep-playa music zone, drawn faintly so it reads as "a place" not a road.
    fillShapes(city.dmz, "#241f2e", 0.85);

    fillShapes(city.blocks, "#3a3128", 0.95);   // camping blocks
    fillShapes(plazaShapes, "#4a3d2c", 0.95);   // plazas carry a name; see below

    strokeShapes(city.gate_road, "#5b5148", Math.max(1, 12 * view.scale));

    // Streets, stroked at their real surveyed width (feet -> metres -> pixels).
    for (var i = 0; i < city.streets.length; i++) {
      var s = city.streets[i];
      var px = Math.max(0.6, s.w * 0.3048 * view.scale);
      ctx.strokeStyle = s.k === "annular" || s.k === "avenue" ? "#8d7f6d" : "#6d6154";
      ctx.lineWidth = px;
      ctx.lineCap = "round";
      path(s.p, false);
      ctx.stroke();
    }

    if (view.scale > 0.09) drawStreetLabels();
    if (view.scale > 0.25) drawToilets();
    drawLandmarks();
    drawPins();
    if (gps) drawGps();
    drawScaleBar();
  }

  // Ring labels are placed on the 4:30 radial (due south) where the city is
  // widest, plus clock labels ringed outside K so you can always orient.
  function drawStreetLabels() {
    ctx.font = "600 11px system-ui, sans-serif";
    ctx.fillStyle = "#c9bda9";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    /* Ring labels sit on the 4:30 radial (bearing 180deg — straight south of
       the Man), stacked outward. Blocks are only ~85 m apart, so zoomed out
       that stack collapses into an unreadable smear of letters. Only draw as
       many as will actually fit: if adjacent rings are closer than a line
       height, thin them out, and below that drop to just the inner and outer
       edge so there is still something to orient by. */
    var keys = Object.keys(city.ring_radius_m).sort(function (a, b) {
      return city.ring_radius_m[a] - city.ring_radius_m[b];
    });
    var gapPx = 85 * view.scale;               // typical block spacing on screen
    var stride = gapPx >= 13 ? 1 : gapPx >= 6 ? 2 : 0;

    if (stride === 0) {
      label(keys[0], 0, -city.ring_radius_m[keys[0]]);
      label(keys[keys.length - 1], 0, -city.ring_radius_m[keys[keys.length - 1]]);
    } else {
      for (var i = 0; i < keys.length; i += stride) {
        var r = city.ring_radius_m[keys[i]];
        var name = view.scale > 0.30 ? (city.ring_names[keys[i]] || keys[i]) : keys[i];
        label(name, 0, -r);
      }
    }
    if (view.scale > 0.12) {
      ctx.fillStyle = "#a89e90";
      for (var hh = 2; hh <= 10; hh++) {
        var bearing = (45 + 30 * (hh - 12)) * DEG;
        var rr = city.ring_radius_m.K + 130;
        label(hh + ":00", Math.sin(bearing) * rr, Math.cos(bearing) * rr);
      }
    }
  }

  function label(text, x, y) {
    var px = sx(x), py = sy(y);
    if (px < -60 || py < -20 || px > VIEW_W + 60 || py > VIEW_H + 20) return;
    ctx.strokeStyle = "rgba(20,17,14,.9)";
    ctx.lineWidth = 3;
    ctx.strokeText(text, px, py);
    ctx.fillText(text, px, py);
  }

  function drawToilets() {
    ctx.fillStyle = "#5d7fa8";
    for (var i = 0; i < city.toilets.length; i++) {
      var t = city.toilets[i];
      ctx.beginPath();
      ctx.arc(sx(t[0]), sy(t[1]), 3.5, 0, 6.284);
      ctx.fill();
    }
  }

  function drawLandmarks() {
    ctx.font = "600 11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    for (var i = 0; i < city.landmarks.length; i++) {
      var m = city.landmarks[i];
      var big = m.n === "The Man" || m.n === "The Temple" || m.n === "Center Camp";
      if (!big && view.scale < 0.22) continue;
      // The selected pin draws its own label; drawing both overprints them.
      if (selected && selected.id === "lm:" + m.n) continue;
      var px = sx(m.p[0]), py = sy(m.p[1]);
      ctx.fillStyle = big ? "#e8d5a8" : "#8b8073";
      ctx.beginPath();
      ctx.arc(px, py, big ? 5 : 3, 0, 6.284);
      ctx.fill();
      if (big || view.scale > 0.4) {
        ctx.fillStyle = "#c9bda9";
        ctx.strokeStyle = "rgba(20,17,14,.9)";
        ctx.lineWidth = 3;
        ctx.strokeText(m.n, px, py - 7);
        ctx.fillText(m.n, px, py - 7);
      }
    }
  }

  function drawPins() {
    var items = mode === "places" ? allPlaces()
              : mode === "agenda" ? agendaEvents().map(function (a) { return a.event; })
              : visibleItems().concat(matchingPlaces());
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.font = "600 11px system-ui, sans-serif";
    for (var i = 0; i < items.length; i++) {
      var e = items[i];
      if (e.x == null) continue;
      var px = sx(e.x), py = sy(e.y);
      if (px < -30 || py < -30 || px > VIEW_W + 30 || py > VIEW_H + 30) continue;
      var isStar = isStarred(e) || e.c;
      var isSel = selected && selected.id === e.id;
      ctx.fillStyle = isSel ? "#ff8c42" : isStar ? "#ffd166" : "#e07a3e";
      ctx.strokeStyle = "rgba(20,17,14,.85)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, isSel ? 8 : 5.5, 0, 6.284);
      ctx.fill();
      ctx.stroke();
      if (isSel) {
        ctx.fillStyle = "#f2ece3";
        ctx.strokeStyle = "rgba(20,17,14,.9)";
        ctx.lineWidth = 3;
        ctx.strokeText(e.t, px, py - 11);
        ctx.fillText(e.t, px, py - 11);
      }
    }
  }

  function drawGps() {
    var px = sx(gps.x), py = sy(gps.y);
    var sim = !!gps.sim;

    // Amber + dashed for a simulated fix, blue + solid for a real one. On playa
    // in the dark you must be able to tell at a glance which one you are
    // looking at, without reading anything.
    var body = sim ? "#ffb020" : "#4da3ff";
    var halo = sim ? "rgba(255,176,32,.16)" : "rgba(77,163,255,.15)";

    if (gps.acc) {
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(px, py, Math.max(4, gps.acc * view.scale), 0, 6.284);
      ctx.fill();
    }
    if (sim) {
      ctx.strokeStyle = body;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.arc(px, py, 15, 0, 6.284);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = body;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(px, py, 7, 0, 6.284);
    ctx.fill();
    ctx.stroke();

    if (sim) {
      ctx.font = "700 10px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = body;
      ctx.strokeStyle = "rgba(20,17,14,.9)";
      ctx.lineWidth = 3;
      ctx.strokeText("SIMULATED", px, py + 19);
      ctx.fillText("SIMULATED", px, py + 19);
    }
  }

  function drawScaleBar() {
    // Pick a round distance that renders 60-140 px wide.
    var choices = [50, 100, 200, 500, 1000, 2000];
    var metres = choices[0];
    for (var i = 0; i < choices.length; i++) {
      if (choices[i] * view.scale <= 140) metres = choices[i];
    }
    var w = metres * view.scale;
    var x = 14, y = VIEW_H - 108;
    ctx.strokeStyle = "rgba(242,236,227,.75)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y - 5);
    ctx.stroke();
    ctx.fillStyle = "rgba(242,236,227,.75)";
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(metres >= 1000 ? (metres / 1000) + " km" : metres + " m", x, y - 7);
  }

  // --- data selection ----------------------------------------------------
  function defaultDayIndex() {
    var today = new Date().toISOString().slice(0, 10);
    for (var i = 0; i < days.length; i++) if (days[i].date >= today) return i;
    return 0;
  }

  function visibleItems() {
    var list = days[dayIndex] ? days[dayIndex].events : [];
    var q = query.trim().toLowerCase();
    return list.filter(function (e) {
      if (!q) return true;
      return (e.t + " " + (e.h || "") + " " + (e.a || "") + " " + (e.k || "") +
              " " + ((e.ln || []).join(" "))).toLowerCase().indexOf(q) >= 0;
    });
  }

  // --- list rendering ----------------------------------------------------
  var listEl = document.getElementById("list");
  var countEl = document.getElementById("count");

  function hhmm(iso) { return iso.slice(11, 16); }

  /* An empty list has several quite different causes, and "Nothing here" tells
     you none of them. In particular, a build with no API key yet shows only
     your curated entries -- which looks broken unless it says so. */
  function emptyReason() {
    if (query) return "Nothing matches <b>" + escapeHtml(query) + "</b>.<br>Try a camp name, a street, or a landmark.";
    if (!officialListings) {
      return "No event listings in this build yet.<br><br>" +
             "The map, all " + city.landmarks.length + " landmarks and your own list work now. " +
             "Official events need a Burning Man API key —<br>rebuild with <code>--refresh</code> once it arrives.";
    }
    return "No listings on this day.";
  }

  function escapeHtml(t) {
    return t.replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function placeRow(place) {
    var row = document.createElement("div");
    row.className = "item place" + (selected && selected.id === place.id ? " sel" : "");

    var kind = document.createElement("div");
    kind.className = "when";
    kind.textContent = { camp: "camp", art: "art", landmark: "civic",
                         plaza: "plaza", curated: "★", venue: "venue" }[place.k] || place.k;

    var body = document.createElement("div");
    body.className = "body";
    var title = document.createElement("div");
    title.className = "title";
    title.textContent = place.t;
    var meta = document.createElement("div");
    meta.className = "meta" + (place.x == null ? " nogeo" : "");
    meta.textContent = place.x == null ? "⚠ not placed yet" : (place.a || "");
    body.appendChild(title);
    body.appendChild(meta);

    var star = document.createElement("div");
    star.className = "star" + (isStarred(place) ? " on" : "");
    star.textContent = isStarred(place) ? "★" : "☆";
    star.onclick = function (ev) {
      ev.stopPropagation();
      toggleStar(place);
      renderList();
      draw();
    };

    row.appendChild(kind);
    row.appendChild(body);
    if (mediaSrc(place)) row.appendChild(thumb(place));
    row.appendChild(star);
    row.onclick = function () { select(place, true); };
    return row;
  }

  function agendaRow(entry) {
    var e = entry.event;
    var row = document.createElement("div");
    row.className = "item" + (selected && selected.id === e.id ? " sel" : "");

    var when = document.createElement("div");
    when.className = "when";
    when.textContent = e.ad ? "all day" : hhmm(e.s);

    var body = document.createElement("div");
    body.className = "body";
    var title = document.createElement("div");
    title.className = "title";
    title.textContent = (e.c ? "★ " : "") + e.t;
    var meta = document.createElement("div");
    meta.className = "meta" + (e.x == null ? " nogeo" : "");
    meta.textContent = (e.x == null ? "⚠ no location · " : "") +
      [e.a, e.h, e.k].filter(Boolean).join(" · ");
    body.appendChild(title);
    body.appendChild(meta);
    /* Who is playing, when you know. The official data never carries this --
       camps register the party, not the bill -- so it only ever comes from
       curated.yaml. Given its own line because it is the thing you are
       actually scanning for at 1 a.m. */
    if (e.ln && e.ln.length) {
      var lineup = document.createElement("div");
      lineup.className = "lineup";
      lineup.textContent = "♪ " + e.ln.join(" · ");
      body.appendChild(lineup);
    }

    var star = document.createElement("div");
    star.className = "star" + (isStarred(e) ? " on" : "");
    star.textContent = isStarred(e) ? "★" : "☆";
    star.onclick = function (ev) {
      ev.stopPropagation();
      toggleStar(e);
      renderList();
      draw();
    };

    row.appendChild(when);
    row.appendChild(body);
    if (mediaSrc(e)) row.appendChild(thumb(e));
    row.appendChild(star);
    row.onclick = function () { select(e, true); };
    return row;
  }

  /* A thumbnail in the row itself. The image is already inlined, so showing it
     small costs nothing extra and makes the row scannable. */
  function thumb(item) {
    var src = mediaSrc(item);
    var img = document.createElement("img");
    img.className = "rowthumb";
    img.src = src;
    img.alt = "";
    img.loading = "lazy";
    img.onclick = function (ev) { ev.stopPropagation(); openLightbox(src, item.t); };
    return img;
  }

  function renderAgenda() {
    var entries = agendaEvents();
    var scope = agendaDay !== null && days[agendaDay]
      ? " on " + days[agendaDay].label + " · tap it again for the week"
      : " this week";
    countEl.textContent = entries.length +
      (entries.length === 1 ? " thing on" : " things on") + " your list" + scope;
    listEl.innerHTML = "";

    if (!entries.length) {
      listEl.innerHTML = '<div class="empty">' +
        (query ? "Nothing of yours matches <b>" + escapeHtml(query) + "</b>."
         : agendaDay !== null
           ? "Nothing of yours on " + escapeHtml(days[agendaDay].label) +
             ". Tap the day again for the whole week."
               : "Your list is empty.<br><br>Tap ☆ on any listing to add it, or put it in " +
                 "<code>data/curated.yaml</code> and rebuild.") + "</div>";
      return;
    }

    // Chronological, with a heading each time the day rolls over. The rows
    // stay in time order; the headings just stop you losing your place.
    var frag = document.createDocumentFragment();
    var currentDay = null;
    entries.forEach(function (entry) {
      if (entry.dayLabel !== currentDay) {
        currentDay = entry.dayLabel;
        frag.appendChild(heading(currentDay));
      }
      frag.appendChild(agendaRow(entry));
    });
    listEl.appendChild(frag);

    var note = document.createElement("div");
    note.className = "hint";
    note.textContent = "Everything you have starred, earliest first. Tap ★ again for the day view.";
    listEl.appendChild(note);
  }

  function renderPlaceList() {
    var list = allPlaces();
    countEl.textContent = list.length + (list.length === 1 ? " place" : " places");
    listEl.innerHTML = "";

    if (!list.length) {
      listEl.innerHTML = '<div class="empty">' +
        (query ? "Nothing matches <b>" + escapeHtml(query) + "</b>."
               : "No places in this build.") + "</div>";
      return;
    }

    var frag = document.createDocumentFragment();
    groupPlaces(list).forEach(function (group) {
      frag.appendChild(heading(group.label + "  (" + group.items.length + ")"));
      group.items.forEach(function (place) { frag.appendChild(placeRow(place)); });
    });
    listEl.appendChild(frag);
  }

  function heading(text) {
    var h = document.createElement("div");
    h.className = "sectionhead";
    h.textContent = text;
    return h;
  }

  function renderChips() {
    var el = document.getElementById("days");
    var today = new Date().toISOString().slice(0, 10);
    el.innerHTML = "";
    days.forEach(function (d, i) {
      var b = document.createElement("button");
      /* In ★ the chips narrow the agenda rather than leaving it, so the
         highlight follows `agendaDay` there and `dayIndex` everywhere else. */
      var active = mode === "agenda" ? (i === agendaDay) : (i === dayIndex);
      b.className = "chip" + (active ? " on" : "") + (d.date === today ? " today" : "");
      b.textContent = d.label;
      b.onclick = function () {
        selected = null;
        if (mode === "agenda") {
          // Tapping the active day again widens back out to the whole week --
          // otherwise there is no way back without leaving ★ and returning.
          agendaDay = (agendaDay === i) ? null : i;
        } else {
          dayIndex = i;
          if (mode !== "events") {        // picking a day means "show me that day"
            mode = "events";
            starBtn.classList.remove("on");
            placesBtn.classList.remove("on");
            document.getElementById("days").classList.remove("muted");
          }
        }
        renderChips();
        renderList();
        draw();
      };
      el.appendChild(b);
    });
    var on = el.querySelector(".chip.on");
    if (on) on.scrollIntoView({ inline: "center", block: "nearest" });
  }

  function renderList() {
    if (mode === "places") return renderPlaceList();
    if (mode === "agenda") return renderAgenda();

    var items = visibleItems();
    var found = matchingPlaces();
    var nowIso = new Date().toISOString();
    countEl.textContent = items.length + (items.length === 1 ? " listing" : " listings") +
      (found.length ? " · " + found.length + " place" + (found.length === 1 ? "" : "s") : "");
    listEl.innerHTML = "";

    if (!items.length && !found.length) {
      listEl.innerHTML = '<div class="empty">' + emptyReason() + "</div>";
      return;
    }

    if (found.length) {
      listEl.appendChild(heading("Places"));
      found.forEach(function (p) { listEl.appendChild(placeRow(p)); });
      if (items.length) listEl.appendChild(heading("Listings on " + days[dayIndex].label));
    }

    var frag = document.createDocumentFragment();
    items.forEach(function (e) {
      var row = document.createElement("div");
      var live = e.s <= nowIso && nowIso <= (e.e || e.s);
      row.className = "item" + (selected && selected.id === e.id ? " sel" : "") + (live ? " now" : "");

      var when = document.createElement("div");
      when.className = "when";
      when.textContent = e.ad ? "all day" : hhmm(e.s);

      var body = document.createElement("div");
      body.className = "body";
      var title = document.createElement("div");
      title.className = "title";
      title.textContent = (e.c ? "★ " : "") + e.t;
      var meta = document.createElement("div");
      meta.className = "meta" + (e.x == null ? " nogeo" : "");
      meta.textContent = (e.x == null ? "⚠ no location · " : "") +
        [e.a, e.h, e.k].filter(Boolean).join(" · ");
      body.appendChild(title);
      body.appendChild(meta);
      /* Who is playing. The official data never names artists -- camps register
         the party, not the bill -- so this only ever comes from curated.yaml.
         Its own line because it is what you are scanning for at 1 a.m. */
      if (e.ln && e.ln.length) {
        var lineup = document.createElement("div");
        lineup.className = "lineup";
        lineup.textContent = "♪ " + e.ln.join(" · ");
        body.appendChild(lineup);
      }

      var star = document.createElement("div");
      star.className = "star" + (isStarred(e) ? " on" : "");
      star.textContent = isStarred(e) ? "★" : "☆";
      star.onclick = function (ev) {
        ev.stopPropagation();
        toggleStar(e);
        renderList();
        draw();
      };

      row.appendChild(when);
      row.appendChild(body);
      if (mediaSrc(e)) row.appendChild(thumb(e));
      row.appendChild(star);
      row.onclick = function () { select(e, true); };
      frag.appendChild(row);
    });
    listEl.appendChild(frag);

    var note = document.createElement("div");
    note.className = "hint";
    note.textContent = "Tap a listing to centre the map on it. ☆ to star — stars are saved on this phone and persist across reloads.";
    listEl.appendChild(note);
  }

  // --- selection & detail -------------------------------------------------
  var detail = document.getElementById("detail");

  function select(e, recentre) {
    selected = e;
    if (recentre && e.x != null) {
      if (view.scale < 0.35) view.scale = 0.35;
      centreOn(e.x, e.y);
      follow = false;
      setFollowButton();
    }
    showDetail(e);
    renderList();
    draw();
  }

  function showDetail(e) {
    var starred = isStarred(e);
    detail.innerHTML = "";
    var h = document.createElement("h2");
    h.textContent = e.t;
    var addr = document.createElement("div");
    addr.className = "addr";
    addr.textContent = e.a || (e.x == null ? "location unknown" : "");
    detail.appendChild(h);
    detail.appendChild(addr);

    if (e.h) {
      var host = document.createElement("div");
      host.className = "meta";
      host.textContent = "at " + e.h;
      detail.appendChild(host);
    }
    if (e.s) {
      var times = document.createElement("div");
      times.className = "times";
      times.textContent = e.ad ? "All day" : hhmm(e.s) + (e.e && e.e !== e.s ? " – " + hhmm(e.e) : "");
      detail.appendChild(times);
    }

    if (e.ln && e.ln.length) {
      var bill = document.createElement("div");
      bill.className = "lineup big";
      bill.textContent = "♪ " + e.ln.join(" · ");
      detail.appendChild(bill);
    }

    /* Stacked rather than a carousel: it is a handful of images, and a swipe
       gesture is a thing to learn at 2 a.m. Each one opens full screen. */
    mediaSrcs(e).forEach(function (src) {
      var fig = document.createElement("img");
      fig.className = "detailimg";
      fig.src = src;                   // inlined data URI: no network needed
      fig.alt = e.t;
      fig.loading = "lazy";
      fig.onclick = function (ev) { ev.stopPropagation(); openLightbox(src, e.t); };
      detail.appendChild(fig);
    });

    if (e.d) {
      var desc = document.createElement("div");
      desc.className = "desc";
      desc.textContent = e.d.length > 400 ? e.d.slice(0, 400) + "…" : e.d;
      detail.appendChild(desc);
    }
    if (e.pl) {
      var badge = document.createElement("div");
      badge.className = "badge";
      badge.textContent = { exact: "exact coordinates",
                            address: "geocoded from address",
                            camp: "at the host camp" }[e.pl] || e.pl;
      detail.appendChild(badge);
    }

    var row = document.createElement("div");
    row.className = "row";
    var starBtn = document.createElement("button");
    starBtn.className = starred ? "primary" : "";
    starBtn.textContent = starred ? "★ Starred" : "☆ Star";
    starBtn.onclick = function () { toggleStar(e); showDetail(e); renderList(); draw(); };
    var close = document.createElement("button");
    close.textContent = "Close";
    close.onclick = hideDetail;
    row.appendChild(starBtn);
    row.appendChild(close);
    detail.appendChild(row);
    detail.classList.add("show");
  }

  function hideDetail() { detail.classList.remove("show"); }

  /* Tap an image to see it full screen. Posters are the whole reason media
     exists here -- a set-times list at thumbnail size is decoration. */
  function openLightbox(src, alt) {
    var box = document.getElementById("lightbox");
    if (!box) {
      box = document.createElement("div");
      box.id = "lightbox";
      box.innerHTML = '<button class="close" aria-label="Close">✕</button><img alt="">';
      box.onclick = function () { box.classList.remove("show"); };
      document.body.appendChild(box);
    }
    var img = box.querySelector("img");
    img.src = src;
    img.alt = alt || "";
    box.classList.add("show");
  }

  window.addEventListener("keydown", function (ev) {
    if (ev.key !== "Escape") return;
    var box = document.getElementById("lightbox");
    if (box && box.classList.contains("show")) box.classList.remove("show");
    else hideDetail();
  });

  /* Events star per occurrence (`oid`); places have no occurrences and star on
     their own id. One accessor so the two never diverge. */
  function starKey(item) { return item.oid || item.id; }

  /* Anything from your own curated.yaml starts starred: you already said it
     matters by putting it in the file, and making you star it again on the
     phone is asking the same question twice.

     So `stars` records DEVIATIONS from the default, not the set of starred
     things — 1 for starred, 0 for explicitly unstarred, absent for "whatever
     the default is". That way a set added to curated.yaml next week arrives
     starred without any migration, and unstarring one still sticks.

     Old saves held only starred keys, which reads correctly under this rule:
     absent means default. */
  function isDefaultStarred(item) {
    return !!(item.c || item.k === "curated");
  }
  function isStarred(item) {
    var stored = stars[starKey(item)];
    return stored === undefined ? isDefaultStarred(item) : !!stored;
  }

  function toggleStar(item) {
    var key = starKey(item);
    var next = isStarred(item) ? 0 : 1;
    // An explicit 0 has to be stored, not deleted: deleting would fall back to
    // the default, which for a curated item is starred -- the toggle would do
    // nothing and look broken.
    if (next === (isDefaultStarred(item) ? 1 : 0)) delete stars[key];
    else stars[key] = next;
    try { localStorage.setItem("brc.stars", JSON.stringify(stars)); } catch (err) {}
  }
  function loadStars() {
    try { return JSON.parse(localStorage.getItem("brc.stars") || "{}"); } catch (err) { return {}; }
  }

  // --- pointer interaction ------------------------------------------------
  var pointers = {}, lastPinch = 0, moved = 0;

  canvas.addEventListener("pointerdown", function (ev) {
    canvas.setPointerCapture(ev.pointerId);
    pointers[ev.pointerId] = { x: ev.clientX, y: ev.clientY };
    moved = 0;
  });

  canvas.addEventListener("pointermove", function (ev) {
    var p = pointers[ev.pointerId];
    if (!p) return;
    var ids = Object.keys(pointers);

    if (ids.length === 1) {
      var dx = ev.clientX - p.x, dy = ev.clientY - p.y;
      view.x -= dx / view.scale;
      view.y += dy / view.scale;
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved > 8 && follow) { follow = false; setFollowButton(); }
    } else if (ids.length === 2) {
      var a = pointers[ids[0]], b = pointers[ids[1]];
      var dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (lastPinch) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, dist / lastPinch);
      lastPinch = dist;
      moved += 20;
    }
    p.x = ev.clientX; p.y = ev.clientY;
    draw();
  });

  function endPointer(ev) {
    if (Object.keys(pointers).length === 1 && moved < 8) tapAt(ev.clientX, ev.clientY);
    delete pointers[ev.pointerId];
    if (Object.keys(pointers).length < 2) lastPinch = 0;
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", function (ev) { delete pointers[ev.pointerId]; lastPinch = 0; });

  canvas.addEventListener("dblclick", function () { fitCity(); draw(); });

  canvas.addEventListener("wheel", function (ev) {
    ev.preventDefault();
    zoomAt(ev.clientX, ev.clientY, Math.exp(-ev.deltaY * 0.0016));
    draw();
  }, { passive: false });

  function zoomAt(px, py, factor) {
    var before = unproject(px, py);
    view.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, view.scale * factor));
    var after = unproject(px, py);
    view.x += before.x - after.x;
    view.y += before.y - after.y;
  }

  /* Tap picks the nearest pin within a finger's width. Searching the visible
     list rather than an index is fine -- it is a few hundred items. */
  function tapAt(px, py) {
    var items = visibleItems(), best = null, bestD = 26;
    for (var i = 0; i < items.length; i++) {
      var e = items[i];
      if (e.x == null) continue;
      var d = Math.hypot(sx(e.x) - px, sy(e.y) - py);
      if (d < bestD) { bestD = d; best = e; }
    }
    if (best) { select(best, false); }
    else { selected = null; hideDetail(); renderList(); draw(); }
  }

  // --- simulated fixes (testing only) -------------------------------------

  /* Resolve "temple", "the man", "9:00 & G Plaza" or "lat,lon" to a point in
     local metres. Landmark matching is the same substring rule the search box
     uses, so anything findable in the app is usable here. */
  function resolveSim(spec) {
    var explicit = spec.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (explicit) {
      var pt = toLocal(parseFloat(explicit[1]), parseFloat(explicit[2]));
      return { x: pt.x, y: pt.y, label: explicit[1] + ", " + explicit[2] };
    }
    /* Search the same index the search box uses -- landmarks, plazas, camps,
       art -- so anything you can find in the app is a valid sim target. An
       exact match wins over a substring, so "man" gives The Man rather than
       the first camp with "man" in its name. */
    var want = spec.toLowerCase().replace(/[_+]/g, " ").trim();
    var exact = null, partial = null;
    for (var i = 0; i < placeIndex.length; i++) {
      var candidate = placeIndex[i];
      if (candidate.x == null) continue;                 // unplaced: nothing to sit on
      var name = candidate.t.toLowerCase();
      if (name === want || name === "the " + want) { exact = candidate; break; }
      if (!partial && name.indexOf(want) >= 0) partial = candidate;
    }
    var hit = exact || partial;
    return hit ? { x: hit.x, y: hit.y, label: hit.t } : null;
  }

  function startSim(spec) {
    var target = resolveSim(spec);
    if (!target) { toast('Unknown place: "' + spec + '"'); return; }
    gps = { x: target.x, y: target.y, acc: 8, sim: true, label: target.label };
    diag.lastFixAt = Date.now();
    follow = true;
    setFollowButton();
    view.scale = Math.max(view.scale, 0.5);
    centreOn(gps.x, gps.y);
    showSimBanner(target.label);
    renderDiag();          // the panel is written before the sim starts
    draw();
  }

  function showSimBanner(label) {
    var el = document.getElementById("simbanner");
    if (!el) {
      el = document.createElement("div");
      el.id = "simbanner";
      document.body.appendChild(el);
    }
    el.textContent = "SIMULATED POSITION — " + label + " · not your real location";
  }

  // --- geolocation --------------------------------------------------------
  /* GPS works with no cell service -- the satellites do not care that you are
     in the desert. This is the whole reason the app is worth building. */
  var followBtn = document.getElementById("locate");

  function setFollowButton() {
    followBtn.classList.toggle("on", follow);
    renderDiag();
  }

  followBtn.onclick = function () {
    if (!navigator.geolocation) return toast("This browser has no geolocation.");
    follow = !follow;
    setFollowButton();
    if (!follow) { updateRangePill(); return; }
    toast("Finding you…");
    navigator.geolocation.getCurrentPosition(onFix, onFixError, {
      enableHighAccuracy: true, timeout: 15000, maximumAge: 5000
    });
    if (!watchId) {
      watchId = navigator.geolocation.watchPosition(onFix, onFixError, {
        enableHighAccuracy: true, maximumAge: 3000, timeout: 30000
      });
    }
  };

  /* Beyond this, you are not at Black Rock City. The trash fence is ~2.5 km
     from the Man, so 10 km is comfortably outside it without tripping on a
     bad fix while you are actually in the city. */
  var OFF_PLAYA_M = 10000;

  var watchId = null;
  function onFix(pos) {
    if (simSpec) return;                     // a real fix must not override a sim
    var p = toLocal(pos.coords.latitude, pos.coords.longitude);
    gps = { x: p.x, y: p.y, acc: pos.coords.accuracy || 0 };
    gps.range = Math.hypot(p.x, p.y);        // metres from the Man
    gps.offPlaya = gps.range > OFF_PLAYA_M;
    diag.lastFixAt = Date.now();
    diag.lastError = null;

    /* Following a fix that is 800 km away pans the map into empty desert and
       the city vanishes -- which looks exactly like the app breaking. Stay on
       the city and say how far off you are instead. */
    if (follow && !gps.offPlaya) {
      view.x = p.x;
      view.y = p.y;
      if (view.scale < 0.25) view.scale = 0.25;
    }
    updateRangePill();
    renderDiag();
    draw();
  }

  /* A standing readout of how far you are from the Man, shown only when you
     are not there. Useful on the drive in, and it explains why the map did not
     jump to you. */
  function updateRangePill() {
    var el = document.getElementById("rangepill");
    if (!gps || !gps.offPlaya) {
      if (el) el.remove();
      return;
    }
    if (!el) {
      el = document.createElement("div");
      el.id = "rangepill";
      document.body.appendChild(el);
    }
    var km = gps.range / 1000;
    var bearing = (Math.atan2(-gps.x, -gps.y) * 180 / Math.PI + 360) % 360;
    var compass = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(bearing / 45) % 8];
    el.textContent = "You are " + (km < 10 ? km.toFixed(1) : Math.round(km)) +
                     " km from the Man — head " + compass;
  }

  var GEO_ERRORS = { 1: "PERMISSION_DENIED", 2: "POSITION_UNAVAILABLE", 3: "TIMEOUT" };

  function onFixError(err) {
    follow = false;
    setFollowButton();
    diag.lastError = "(" + err.code + " " + (GEO_ERRORS[err.code] || "?") + ") " +
                     (err.message || "no message");
    renderDiag();
    toast(err.code === 1 ? "Location permission denied."
        : err.code === 2 ? "Position unavailable — no GPS signal."
        : "Timed out waiting for a fix — try outside.");
  }

  /* Everything "no blue dot" could mean, on one line each. Without this you
     are guessing on a device with no console. */
  function renderDiag() {
    if (!debugOn) return;
    var el = document.getElementById("diag");
    if (!el) {
      el = document.createElement("div");
      el.id = "diag";
      document.body.appendChild(el);
    }
    var age = diag.lastFixAt ? Math.round((Date.now() - diag.lastFixAt) / 1000) + "s ago" : "never";

    /* Whether this browser can actually keep the app offline. On iOS every
       browser runs on WebKit, so the map and GPS behave identically -- but
       service workers and real Home Screen web apps have not always been
       available outside Safari, and those are exactly what offline depends on.
       Rather than guess per browser and version, ask the device. */
    var standalone = window.matchMedia("(display-mode: standalone)").matches ||
                     window.navigator.standalone === true;
    var rows = [
      ["origin", location.origin || "file:// (no origin)"],
      ["secure context", window.isSecureContext ? "yes" : "NO — geolocation is blocked"],
      ["geolocation API", navigator.geolocation ? "present" : "MISSING"],
      ["permission", diag.permission],
      ["following", follow ? "yes" : "no"],
      ["last fix", age + (gps ? "  ±" + Math.round(gps.acc) + "m" + (gps.sim ? "  (SIMULATED)" : "") : "")],
      ["distance to Man", gps && gps.range !== undefined
        ? (gps.range / 1000).toFixed(gps.range < 10000 ? 2 : 0) + " km" +
          (gps.offPlaya ? "  (off playa)" : "  (in the city)")
        : "no fix yet"],
      ["last error", diag.lastError || "none"],
      ["launched as", standalone ? "home screen app" : "browser tab"],
      // Which build is this device actually running? Without it the only way to
      // tell a stale cached copy from a current one is to hunt for a listing you
      // know changed -- and on playa there is no network to check against.
      ["build", (document.querySelector('meta[name="brc-build"]') || {}).content || "unknown"],
      ["service worker", "serviceWorker" in navigator ? diag.swState : "UNSUPPORTED — no offline"],
      ["cache storage", "caches" in window ? "present" : "MISSING — no offline"],
      ["cached files", diag.cachedCount === null ? "checking…" : String(diag.cachedCount)],
      ["storage used", diag.storage || "unknown"],
    ];
    el.innerHTML = rows.map(function (r) {
      var bad = /NO |MISSING|UNSUPPORTED|denied|PERMISSION|UNAVAILABLE|TIMEOUT/.test(r[1]);
      return '<div><span>' + r[0] + '</span><b class="' + (bad ? "bad" : "") + '">' +
             String(r[1]).replace(/[<>&]/g, "") + "</b></div>";
    }).join("");
  }

  /* Ask the browser what it can actually do, rather than inferring it from the
     user agent -- which lies, and which changes underneath you. */
  if (debugOn) {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.getRegistration().then(function (reg) {
        diag.swState = !reg ? "supported, none registered"
                     : reg.active ? "active — offline should work"
                     : reg.installing ? "installing…" : "registered, not active";
        renderDiag();
      }).catch(function () { diag.swState = "error querying"; renderDiag(); });
    }
    if ("caches" in window) {
      caches.keys().then(function (keys) {
        if (!keys.length) { diag.cachedCount = 0; return renderDiag(); }
        return caches.open(keys[0]).then(function (c) { return c.keys(); })
          .then(function (reqs) { diag.cachedCount = reqs.length; renderDiag(); });
      }).catch(function () { diag.cachedCount = -1; renderDiag(); });
    } else {
      diag.cachedCount = 0;
    }
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (est) {
        diag.storage = Math.round((est.usage || 0) / 1024) + " KB of " +
                       Math.round((est.quota || 0) / 1048576) + " MB";
        renderDiag();
      }).catch(function () {});
    }
  }

  if (debugOn && navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: "geolocation" }).then(function (st) {
      diag.permission = st.state;
      st.onchange = function () { diag.permission = st.state; renderDiag(); };
      renderDiag();
    }).catch(function () { diag.permission = "unsupported"; renderDiag(); });
  }

  var toastEl = document.getElementById("toast"), toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 2200);
  }

  // --- chrome -------------------------------------------------------------
  document.getElementById("search").addEventListener("input", function (ev) {
    query = ev.target.value;
    selected = null;
    renderList();
    draw();
  });

  var starBtn = document.getElementById("starfilter");
  var placesBtn = document.getElementById("placesbtn");

  /* One mode at a time. Tapping the active button returns to the day view,
     so both buttons are their own way out. */
  function setMode(next) {
    mode = (mode === next) ? "events" : next;
    starBtn.classList.toggle("on", mode === "agenda");
    placesBtn.classList.toggle("on", mode === "places");
    // Day chips only mean something in the day view.
    // Chips are meaningful in ★ too now, so only the places view mutes them.
    document.getElementById("days").classList.toggle("muted", mode === "places");
    selected = null;
    hideDetail();
    sheet.classList.remove("down");        // opening a list and hiding it is silly
    renderList();
    draw();
  }

  starBtn.onclick = function () { setMode("agenda"); };
  placesBtn.onclick = function () { setMode("places"); };

  document.getElementById("grab").onclick = function () {
    sheet.classList.toggle("down");
    setTimeout(draw, 240);
  };

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) { renderList(); draw(); }   // "now" highlighting goes stale
  });

  /* Reset the view: whole city, everything visible. The same thing
     double-tapping the map does, but discoverable. */
  document.getElementById("fitbtn").onclick = function () {
    follow = false;
    setFollowButton();
    fitCity();
    draw();
  };

  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", function () { setTimeout(resize, 120); });
  /* iOS reports a zero-height viewport on first paint and then settles, and
     the URL bar collapsing fires no resize event on some versions. Observing
     the BODY (never the canvas -- see resize()) catches both. */
  if (window.ResizeObserver) new ResizeObserver(resize).observe(document.body);
  window.addEventListener("load", resize);

  // A demo build must never be mistakable for the real thing.
  if (D.meta && D.meta.demo) {
    var banner = document.createElement("div");
    banner.id = "demobanner";
    banner.textContent = "DEMO DATA — every listing here is invented";
    document.body.appendChild(banner);
  }

  // --- go -----------------------------------------------------------------
  if (debugOn) renderDiag();
  if (simSpec) setTimeout(function () { startSim(simSpec); }, 0);

  renderChips();
  renderList();
  resize();
})();
