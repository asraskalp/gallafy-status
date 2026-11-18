#!/usr/bin/env node
// status.gallafy.com's one run (docs/adr/0601): check every component, fold
// the answers into the saved state, and write the site.
//
//   node probe.mjs --state <state.json> --out <dir>                # probe, then render
//   node probe.mjs --state <state.json> --out <dir> --render-only  # render only (an incident edit)
//
// Every URL it calls is in config.json, public and unauthenticated. It sends no
// key, no token and no cookie, and it never logs a response body. The state
// file is the only thing it writes outside --out.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseIncident, sortIncidents } from "./lib/incidents.mjs";
import { buildModel, compareLocale, renderPage } from "./lib/render.mjs";
import { advance, classifyResponse, combineOutcomes, emptyComponent } from "./lib/state.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const USER_AGENT = "GallafyStatusProbe/1 (+https://status.gallafy.com)";
const ASSETS = [
  "style.css",
  "page.js",
  "favicon.ico",
  "logo-on-light@1x.png",
  "logo-on-light@2x.png",
  "logo-on-dark@1x.png",
  "logo-on-dark@2x.png",
  "anek-latin.var.woff2",
  "OFL.txt",
];

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

async function request(url, timeoutMs) {
  const started = performance.now();
  try {
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT, "cache-control": "no-cache" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.text();
    return {
      status: res.status,
      contentType: res.headers.get("content-type"),
      body,
      ms: Math.round(performance.now() - started),
    };
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    return { error: timedOut ? "timeout" : "network", ms: Math.round(performance.now() - started) };
  }
}

async function probeComponent(component, timeoutMs) {
  const results = await Promise.all(
    component.checks.map(async (check) => {
      const response = await request(check.url, timeoutMs);
      return { ...classifyResponse(check.expect, response, component.slowMs), ms: response.ms };
    }),
  );
  const combined = combineOutcomes(results);
  return { ...combined, ms: Math.max(...results.map((r) => r.ms)) };
}

export function loadIncidents(dir, componentIds, warn) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".md") || name.toLowerCase() === "readme.md") continue;
    const parsed = parseIncident(readFileSync(join(dir, name), "utf8"), name, componentIds);
    if (parsed.error) warn(`incidents/${name}`, parsed.error);
    else out.push(parsed.incident);
  }
  return out;
}

/** Every language file under strings/ that matches English key for key. A partial one is skipped, loudly. */
function loadLocales(warn) {
  const dir = join(ROOT, "strings");
  const en = JSON.parse(readFileSync(join(dir, "en.json"), "utf8"));
  const locales = { en };
  for (const name of readdirSync(dir)) {
    const lang = name.replace(/\.json$/, "");
    if (!name.endsWith(".json") || lang === "en") continue;
    const strings = JSON.parse(readFileSync(join(dir, name), "utf8"));
    const { missing, extra } = compareLocale(en, strings);
    if (missing.length || extra.length) {
      warn(
        `strings/${name}`,
        `not published: ${missing.length} missing, ${extra.length} extra keys`,
      );
      continue;
    }
    locales[lang] = strings;
  }
  return locales;
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (flag) => {
    const i = args.indexOf(flag);
    return i === -1 ? null : args[i + 1];
  };
  const statePath = arg("--state");
  const outDir = arg("--out");
  if (!statePath || !outDir) {
    console.error("usage: node probe.mjs --state <state.json> --out <dir> [--render-only]");
    process.exit(2);
  }
  const warn = (file, message) => console.log(`::warning file=${file}::${message}`);

  const config = readJson(join(ROOT, "config.json"));
  const state = readJson(statePath, { version: 1, lastRunAt: null, components: {} });
  const nowMs = Date.now();

  if (!args.includes("--render-only")) {
    const prevRunAt = state.lastRunAt ?? null;
    const outcomes = await Promise.all(
      config.components.map(async (c) => [c.id, await probeComponent(c, config.timeoutMs)]),
    );
    for (const [id, outcome] of outcomes) {
      const prev = state.components[id] ?? emptyComponent();
      state.components[id] = advance(prev, outcome, nowMs, prevRunAt, outcome.ms);
      console.log(
        `${id}: ${outcome.outcome} (${outcome.reason}, ${outcome.ms} ms) -> ${state.components[id].state}`,
      );
    }
    state.lastRunAt = nowMs;
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  const ids = config.components.map((c) => c.id);
  const incidents = sortIncidents(loadIncidents(join(ROOT, "incidents"), ids, warn), nowMs);

  mkdirSync(join(outDir, "assets"), { recursive: true });
  mkdirSync(join(outDir, "data"), { recursive: true });
  for (const name of ASSETS) copyFileSync(join(ROOT, "site", name), join(outDir, "assets", name));

  for (const [lang, strings] of Object.entries(loadLocales(warn))) {
    const dir = lang === "en" ? outDir : join(outDir, lang);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "index.html"),
      renderPage({
        config,
        state,
        incidents,
        strings,
        lang,
        nowMs,
        assetBase: lang === "en" ? "" : "../",
      }),
    );
  }

  // The same facts as the page, for anyone who would rather read JSON.
  const model = buildModel({ config, state, incidents, nowMs });
  const summary = {
    overall: model.overall,
    lastRunAt: model.lastRunAt ? new Date(model.lastRunAt).toISOString() : null,
    components: Object.fromEntries(model.rows.map((r) => [r.id, r.state])),
  };
  writeFileSync(join(outDir, "data", "status.json"), `${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
