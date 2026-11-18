// status.gallafy.com's only script (docs/adr/0601). The page is complete
// without it. It does two things with the visitor's own clock: says how long
// ago the last check ran, and, when that is longer than the stale limit,
// stops the page claiming anything it can no longer back (a copy cached by
// the browser, or a site GitHub stopped refreshing).
/* global document, setInterval -- runs in the visitor's browser, not in Node */
(function () {
  "use strict";
  var root = document.documentElement;
  var lastRun = Number(root.getAttribute("data-last-run"));
  var staleMs = Number(root.getAttribute("data-stale-ms"));
  var words;
  try {
    words = JSON.parse(root.getAttribute("data-ago") || "{}");
  } catch {
    words = {};
  }

  function ago(ms) {
    var mins = Math.floor((Date.now() - ms) / 60000);
    if (mins < 1) return words.now;
    if (mins < 60) return (words.min || "").replace("{n}", String(mins));
    var hours = Math.floor(mins / 60);
    if (hours < 48) return (words.h || "").replace("{n}", String(hours));
    return (words.d || "").replace("{n}", String(Math.floor(hours / 24)));
  }

  function tick() {
    if (!lastRun) return;
    var stamp = document.querySelector("time[data-ago]");
    if (stamp && words.now) {
      var base = stamp.getAttribute("data-base") || stamp.textContent;
      stamp.setAttribute("data-base", base);
      stamp.textContent = base + " (" + ago(lastRun) + ")";
    }
    if (Date.now() - lastRun > staleMs) {
      root.classList.add("is-stale");
      var note = document.querySelector("[data-stale]");
      if (note) note.hidden = false;
      var h1 = document.querySelector(".overall h1");
      var sub = document.querySelector(".overall-sub");
      var overall = document.querySelector(".overall");
      if (h1 && root.getAttribute("data-stale-title"))
        h1.textContent = root.getAttribute("data-stale-title");
      if (sub && root.getAttribute("data-stale-sub"))
        sub.textContent = root.getAttribute("data-stale-sub");
      if (overall) overall.className = "overall overall--unknown";
      var dot = document.querySelector(".overall .dot");
      if (dot) dot.className = "dot dot--unknown";
    }
  }

  tick();
  setInterval(tick, 60000);
})();
