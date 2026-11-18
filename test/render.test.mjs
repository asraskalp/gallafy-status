// The page and the incident notes: what shows, in what words, and that no
// typed character reaches the page as markup.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parseIncident, sortIncidents } from "../lib/incidents.mjs";
import {
  buildModel,
  compareLocale,
  formatDuration,
  renderPage,
  translator,
} from "../lib/render.mjs";
import { STALE_MS, STATES, emptyComponent } from "../lib/state.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"));
const en = JSON.parse(readFileSync(join(ROOT, "strings", "en.json"), "utf8"));
const IDS = config.components.map((c) => c.id);
const NOW = Date.parse("2026-11-12T06:00:00Z");
const NONE = { open: [], past: [] };

function stateWith(overrides = {}) {
  const components = {};
  for (const id of IDS) {
    components[id] = { ...emptyComponent(), state: "operational", lastCheckedAt: NOW };
  }
  Object.assign(components, overrides);
  return { version: 1, lastRunAt: NOW, components };
}

const NOTE = `---
title: GST filing is slow
components: gsp
impact: degraded
status: investigating
started: 2026-11-12T10:30+05:30
---
10:45 IST: Sandbox says the GST portal is answering slowly.

Filing still works.
`;

describe("incident notes", () => {
  it("a well-formed note parses, with one update per paragraph", () => {
    const { incident, error } = parseIncident(NOTE, "2026-11-12-gsp.md", IDS);
    assert.equal(error, undefined);
    assert.equal(incident.id, "2026-11-12-gsp");
    assert.deepEqual(incident.components, ["gsp"]);
    assert.equal(incident.started, Date.parse("2026-11-12T05:00:00Z"));
    assert.equal(incident.updates.length, 2);
  });

  it("a bad note is an error naming the file, never a throw", () => {
    const cases = [
      ["no front matter", "just text"],
      ["missing title", NOTE.replace("title: GST filing is slow\n", "")],
      ["unknown component", NOTE.replace("components: gsp", "components: gstn")],
      ["bad impact", NOTE.replace("impact: degraded", "impact: bad")],
      ["bad status", NOTE.replace("status: investigating", "status: done")],
      ["bad date", NOTE.replace("started: 2026-11-12T10:30+05:30", "started: yesterday")],
      ["resolved with no time", NOTE.replace("status: investigating", "status: resolved")],
    ];
    for (const [label, text] of cases) {
      const r = parseIncident(text, "x.md", IDS);
      assert.ok(r.error?.startsWith("x.md:"), label);
    }
  });

  it("open notes come first; resolved ones older than 90 days drop off", () => {
    const old = { status: "resolved", started: NOW - 91 * 86_400_000 };
    const recent = { status: "resolved", started: NOW - 86_400_000 };
    const open = { status: "monitoring", started: NOW - 200 * 86_400_000 };
    const { open: o, past } = sortIncidents([old, recent, open], NOW);
    assert.deepEqual(o, [open]);
    assert.deepEqual(past, [recent]);
  });

  it("the shipped incidents/ folder holds no note that fails to parse", () => {
    for (const name of readdirSync(join(ROOT, "incidents"))) {
      if (!name.endsWith(".md") || name.toLowerCase() === "readme.md") continue;
      const r = parseIncident(readFileSync(join(ROOT, "incidents", name), "utf8"), name, IDS);
      assert.equal(r.error, undefined, name);
    }
  });
});

describe("the page", () => {
  it("shows only public components: a service not switched on in prod gets no row", () => {
    const model = buildModel({ config, state: stateWith(), incidents: NONE, nowMs: NOW });
    const hidden = config.components.filter((c) => !c.public).map((c) => c.id);
    assert.deepEqual(
      model.rows.map((r) => r.id),
      config.components.filter((c) => c.public).map((c) => c.id),
    );
    const html = renderPage({
      config,
      state: stateWith(),
      incidents: NONE,
      strings: en,
      nowMs: NOW,
    });
    for (const id of hidden) assert.ok(!html.includes(`id="${id}"`), id);
  });

  it("renders every state for every row with no raw key or placeholder left", () => {
    for (const s of STATES) {
      const overrides = Object.fromEntries(
        IDS.map((id) => [id, { ...emptyComponent(), state: s, lastCheckedAt: NOW }]),
      );
      const html = renderPage({
        config,
        state: stateWith(overrides),
        incidents: NONE,
        strings: en,
        nowMs: NOW,
      });
      assert.ok(!/\{\w+\}/.test(html.replace(/data-ago="[^"]*"/, "")), `placeholder left in ${s}`);
      assert.ok(html.includes(`overall--${s === "maintenance" ? "maintenance" : s}`), s);
    }
  });

  it("a page whose checks are stale says so, and claims nothing works", () => {
    const html = renderPage({
      config,
      state: stateWith(),
      incidents: NONE,
      strings: en,
      nowMs: NOW + STALE_MS + 1,
    });
    assert.ok(html.includes('class="overall overall--unknown"'));
    assert.ok(/<p class="stale" role="status" data-stale>/.test(html));
    assert.ok(!html.includes("chip--operational"));
  });

  it("before the first run there is no history and no uptime figure", () => {
    const html = renderPage({
      config,
      state: { version: 1, lastRunAt: null, components: {} },
      incidents: NONE,
      strings: en,
      nowMs: NOW,
    });
    assert.ok(html.includes(en["bars.noHistory"]));
    assert.ok(!/\d%/.test(html));
  });

  it("an incident's text reaches the page escaped, never as markup", () => {
    const evil = NOTE.replace("GST filing is slow", '<script>alert("x")</script>').replace(
      "Filing still works.",
      '<img src=x onerror="alert(1)">',
    );
    const { incident } = parseIncident(evil, "e.md", IDS);
    const html = renderPage({
      config,
      state: stateWith(),
      incidents: sortIncidents([incident], NOW),
      strings: en,
      nowMs: NOW,
    });
    assert.ok(!html.includes("<script>alert"));
    assert.ok(!html.includes("<img src=x"));
    assert.ok(html.includes("&lt;script&gt;"));
  });

  it("an open note colours its row and says a note is posted", () => {
    const { incident } = parseIncident(NOTE, "n.md", IDS);
    const html = renderPage({
      config,
      state: stateWith(),
      incidents: sortIncidents([incident], NOW),
      strings: en,
      nowMs: NOW,
    });
    assert.ok(html.includes("overall--degraded"));
    assert.ok(html.includes(en["line.declared"]));
    assert.ok(html.includes(en["incidents.open"]));
  });

  it("loads no third-party origin: every src and href is our own or a plain link", () => {
    const html = renderPage({
      config,
      state: stateWith(),
      incidents: NONE,
      strings: en,
      nowMs: NOW,
    });
    for (const [, url] of html.matchAll(/\b(?:src|srcset)="([^"]+)"/g)) {
      for (const part of url.split(/,\s*/)) assert.ok(part.startsWith("assets/"), part);
    }
    assert.ok(html.includes("default-src 'none'"));
  });

  it("e-way bills and the IRP each have a row of their own, apart from the GST connection", () => {
    const html = renderPage({
      config,
      state: stateWith(),
      incidents: NONE,
      strings: en,
      nowMs: NOW,
    });
    for (const id of ["gsp", "eway", "einvoice"]) assert.ok(html.includes(`id="${id}"`), id);
    const checks = (id) => config.components.find((c) => c.id === id).checks;
    for (const id of ["eway", "einvoice"]) {
      assert.deepEqual(
        checks(id).map((c) => c.expect.kind),
        ["app-verdict", "answers-json"],
        `${id} reads what the app saw, and the front door`,
      );
      assert.equal(checks(id)[0].expect.system, id);
    }
  });

  it("a row's own line for a state replaces the shared one", () => {
    const down = { ...emptyComponent(), state: "down", lastCheckedAt: NOW };
    const html = renderPage({
      config,
      state: stateWith({ eway: down, gsp: down }),
      incidents: NONE,
      strings: en,
      nowMs: NOW,
    });
    const row = (id) =>
      html.slice(html.indexOf(`id="${id}"`), html.indexOf("</li>", html.indexOf(`id="${id}"`)));
    assert.ok(row("eway").includes(en["component.eway.line.down"].replace(/'/g, "&#39;")));
    assert.ok(!row("eway").includes(en["line.down"]));
    assert.ok(row("gsp").includes(en["line.down"]));
  });

  it("durations read in minutes, then hours and minutes", () => {
    const t = translator(en);
    assert.equal(formatDuration(20, t), "1 min");
    assert.equal(formatDuration(600, t), "10 min");
    assert.equal(formatDuration(3900, t), "1 h 5 min");
  });
});

describe("languages", () => {
  it("every language file matches English key for key", () => {
    for (const name of readdirSync(join(ROOT, "strings"))) {
      if (!name.endsWith(".json") || name === "en.json") continue;
      const other = JSON.parse(readFileSync(join(ROOT, "strings", name), "utf8"));
      assert.deepEqual(compareLocale(en, other), { missing: [], extra: [] }, name);
    }
  });

  it("a translation may move a placeholder; the page fills it wherever it sits", () => {
    const moved = { ...en, lastChecked: "{time} पर जाँचा", "help.body": "{email} · {whatsapp}" };
    const html = renderPage({
      config,
      state: stateWith(),
      incidents: NONE,
      strings: moved,
      lang: "hi",
      nowMs: NOW,
    });
    assert.ok(/<p class="checked"><time [^>]+>[^<]+<\/time> पर जाँचा<\/p>/.test(html));
    assert.ok(/mailto:[^"]+">[^<]+<\/a> · <a href="https:\/\/wa\.me\//.test(html));
    assert.ok(html.startsWith('<!doctype html>\n<html lang="hi"'));
  });

  it("a missing string throws instead of printing its key", () => {
    const { ["state.down"]: _drop, ...partial } = en;
    assert.throws(() => translator(partial)("state.down"), /missing string: state.down/);
  });
});
