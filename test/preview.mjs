#!/usr/bin/env node
// A PREVIEW of the page with made-up history, for screenshots and design
// review only: `node test/preview.mjs <out-dir> [down|stale]`. Nothing here is
// a real measurement, and the workflow never runs this file.

import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseIncident, sortIncidents } from "../lib/incidents.mjs";
import { renderPage } from "../lib/render.mjs";
import { STALE_MS, emptyComponent, istDay, lastDays } from "../lib/state.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.argv[2];
const variant = process.argv[3] ?? "normal";
if (!out) {
  console.error("usage: node test/preview.mjs <out-dir> [down|stale|pseudo]");
  process.exit(2);
}

const config = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"));
let strings = JSON.parse(readFileSync(join(ROOT, "strings", "en.json"), "utf8"));
const nowMs = Date.parse("2026-11-12T09:35:00Z");
const today = istDay(nowMs);
const FULL = 86_400;

// 40 days of made-up history: mostly clean, a few slow or down days.
function history(seed) {
  const days = {};
  lastDays(today, 40).forEach((day, i) => {
    const down = (i * 7 + seed) % 23 === 0 ? 900 : 0;
    const degraded = (i * 5 + seed) % 17 === 0 ? 1500 : 0;
    days[day] = { up: FULL - down - degraded, degraded, down };
  });
  return days;
}

const components = {};
config.components.forEach((c, i) => {
  components[c.id] = {
    ...emptyComponent(),
    state: "operational",
    lastCheckedAt: nowMs,
    days: history(i),
  };
});
if (variant === "down") {
  components.gsp = { ...components.gsp, state: "down" };
}

// 130% of the English length, for the Hindi-length check (rule 695.3).
if (variant === "pseudo") {
  strings = Object.fromEntries(
    Object.entries(strings).map(([k, v]) => {
      if (k === "//" || typeof v !== "string") return [k, v];
      const pad = "ा".repeat(Math.ceil(v.replace(/\{\w+\}/g, "").length * 0.3));
      return [k, `${v} ${pad}`];
    }),
  );
}

const notes = [
  `---
title: Sandbox was not answering
components: gsp
impact: down
status: resolved
started: 2026-11-04T14:05+05:30
resolved: 2026-11-04T14:40+05:30
---
14:10 IST: Our checks cannot reach Sandbox. Filing and e-invoices will wait until it answers.

14:40 IST: Sandbox answers again. Anything you tried in that window can be tried again now.
`,
];
if (variant === "down") {
  notes.push(`---
title: GST filing is not going through
components: gsp
impact: down
status: investigating
started: 2026-11-12T14:55+05:30
---
15:00 IST: Our checks cannot reach Sandbox, our GST Suvidha Provider. Filing, e-invoices and e-way bills will wait until Sandbox answers.
`);
}
const ids = config.components.map((c) => c.id);
const incidents = sortIncidents(
  notes.map((n, i) => parseIncident(n, `preview-${i}.md`, ids).incident),
  nowMs,
);

const state = { version: 1, lastRunAt: nowMs, components };
const renderAt = variant === "stale" ? nowMs + STALE_MS + 60_000 : nowMs;
mkdirSync(join(out, "assets"), { recursive: true });
for (const name of readdirSync(join(ROOT, "site"))) {
  copyFileSync(join(ROOT, "site", name), join(out, "assets", name));
}
writeFileSync(
  join(out, "index.html"),
  renderPage({ config, state, incidents, strings, nowMs: renderAt }),
);
console.log(`PREVIEW (made-up data) written to ${out}`);
