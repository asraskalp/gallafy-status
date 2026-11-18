// Turns the saved state into the one HTML page (docs/adr/0601). Pure: the
// caller passes the clock, the strings and the data. The page is complete
// without JavaScript; site/page.js only re-reads the clock in the visitor's
// browser so a page GitHub stopped refreshing says so.

import {
  STALE_MS,
  dayBars,
  effectiveState,
  formatPct,
  istDay,
  overallState,
  uptime,
} from "./state.mjs";

const LOCALE_TAG = { en: "en-IN", hi: "hi-IN" };

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** `t("ago.min", { n: 3 })`. A missing key throws: a page with a raw key on it never ships. */
export function translator(strings) {
  const t = (key, vars = {}) => {
    const s = strings[key];
    if (typeof s !== "string") throw new Error(`missing string: ${key}`);
    return s.replace(/\{(\w+)\}/g, (_, name) => {
      if (!(name in vars)) throw new Error(`string ${key} needs {${name}}`);
      return String(vars[name]);
    });
  };
  /** Whether a key exists: for the optional ones, like a row's own line. */
  t.has = (key) => typeof strings[key] === "string";
  return t;
}

/** Keys a language file lacks, or has that English does not. Both must be empty to ship it. */
export function compareLocale(base, other) {
  const keys = (o) => Object.keys(o).filter((k) => k !== "//");
  const b = new Set(keys(base));
  const o = new Set(keys(other));
  return {
    missing: [...b].filter((k) => !o.has(k)),
    extra: [...o].filter((k) => !b.has(k)),
  };
}

export function formatTime(ms, lang) {
  const text = new Intl.DateTimeFormat(LOCALE_TAG[lang] ?? "en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(ms));
  return `${text} IST`;
}

export function formatDay(dayKey, lang) {
  return new Intl.DateTimeFormat(LOCALE_TAG[lang] ?? "en-IN", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
  }).format(new Date(`${dayKey}T00:00:00Z`));
}

export function formatDuration(seconds, t) {
  const mins = Math.max(1, Math.round(seconds / 60));
  if (mins < 60) return t("duration.min", { n: mins });
  return t("duration.hm", { h: Math.floor(mins / 60), m: mins % 60 });
}

export function formatAgo(ms, nowMs, t) {
  const mins = Math.floor((nowMs - ms) / 60_000);
  if (mins < 1) return t("ago.now");
  if (mins < 60) return t("ago.min", { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 48) return t("ago.h", { n: hours });
  return t("ago.d", { n: Math.floor(hours / 24) });
}

/**
 * The page's model, separate from its markup so the tests read decisions,
 * not HTML: which rows show, in what state, and what the headline says.
 */
export function buildModel({ config, state, incidents, nowMs }) {
  const shown = config.components.filter((c) => c.public);
  const rows = shown.map((c) => {
    const record = state.components[c.id];
    const rowState = record ? effectiveState(record, c.id, nowMs, incidents.open) : "unknown";
    const declared = incidents.open.some((i) => i.components.includes(c.id) && i.impact !== "none");
    return {
      id: c.id,
      state: rowState,
      declared,
      vendorStatusUrl: c.vendorStatusUrl ?? null,
      bars: dayBars(record?.days ?? {}, istDay(nowMs)),
      uptime: formatPct(uptime(record?.days ?? {})),
    };
  });
  const lastRunAt = state.lastRunAt ?? null;
  const stale = lastRunAt === null || nowMs - lastRunAt > STALE_MS;
  return {
    rows,
    // Stale checks already read UNKNOWN row by row (unless a person's note
    // declares a state), so the headline needs no stale case of its own.
    overall: overallState(rows.map((r) => r.state)),
    lastRunAt,
    stale,
  };
}

/**
 * A string with HTML in its placeholders: the sentence is escaped, then each
 * `{name}` is replaced by trusted markup, so a translation can move the link
 * anywhere in its sentence.
 */
export function fillHtml(t, key, html) {
  const marks = Object.fromEntries(Object.keys(html).map((k, i) => [k, `\u0000${i}\u0000`]));
  let out = escapeHtml(t(key, marks));
  Object.keys(html).forEach((k, i) => {
    out = out.replace(`\u0000${i}\u0000`, html[k]);
  });
  return out;
}

/**
 * `assetBase` is the path from the page to the site root: "" for /index.html,
 * "../" for /hi/index.html. Relative, so the site also works at
 * <owner>.github.io/<repo>/ before the custom domain is set.
 */
export function renderPage({
  config,
  state,
  incidents,
  strings,
  lang = "en",
  nowMs,
  assetBase = "",
}) {
  const t = translator(strings);
  const model = buildModel({ config, state, incidents, nowMs });
  const names = Object.fromEntries(
    config.components.map((c) => [c.id, t(`component.${c.id}.name`)]),
  );
  const e = escapeHtml;

  const checked =
    model.lastRunAt === null
      ? ""
      : `<p class="checked">${fillHtml(t, "lastChecked", {
          time: `<time datetime="${new Date(model.lastRunAt).toISOString()}" data-ago>${e(formatTime(model.lastRunAt, lang))}</time>`,
        })}</p>`;

  const staleNote = `<p class="stale" role="status" data-stale${model.stale ? "" : " hidden"}>${e(
    t("stale", {
      time: model.lastRunAt === null ? "—" : formatTime(model.lastRunAt, lang),
    }),
  )}</p>`;

  const rows = model.rows.map((r) => renderRow(r, t, lang, e)).join("\n");

  // What the headline becomes in the visitor's browser once the checks go
  // stale: the same model, read at a moment past the stale limit.
  const staleOverall = buildModel({
    config,
    state,
    incidents,
    nowMs: Math.max(nowMs, model.lastRunAt ?? 0) + STALE_MS + 1,
  }).overall;
  const agoWords = JSON.stringify({
    now: t("ago.now"),
    min: strings["ago.min"],
    h: strings["ago.h"],
    d: strings["ago.d"],
  });

  const legend = ["operational", "degraded", "down", "nodata"]
    .map(
      (l) =>
        `<li><span class="swatch bar--${l}" aria-hidden="true"></span>${e(t(`legend.${l}`))}</li>`,
    )
    .join("");

  const open = incidents.open.map((i) => renderIncident(i, t, lang, names, e)).join("\n");
  const past = incidents.past.length
    ? incidents.past.map((i) => renderIncident(i, t, lang, names, e)).join("\n")
    : `<p class="muted">${e(t("incidents.none"))}</p>`;

  const contact = config.contact;
  const helpHtml = fillHtml(t, "help.body", {
    whatsapp: `<a href="https://wa.me/${e(contact.whatsappE164)}">${e(contact.whatsappDisplay)}</a>`,
    email: `<a href="mailto:${e(contact.email)}">${e(contact.email)}</a>`,
  });

  return `<!doctype html>
<html lang="${e(lang)}" data-last-run="${model.lastRunAt ?? ""}" data-stale-ms="${STALE_MS}" data-stale-title="${e(t(`overall.${staleOverall}`))}" data-stale-sub="${e(t(`overall.sub.${staleOverall}`))}" data-ago="${e(agoWords)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<meta http-equiv="refresh" content="300">
<title>${e(t(`overall.${model.overall}`))} · ${e(t("meta.title"))}</title>
<meta name="description" content="${e(t("meta.description"))}">
<link rel="canonical" href="${e(config.siteUrl)}/">
<link rel="icon" href="${assetBase}assets/favicon.ico">
<link rel="stylesheet" href="${assetBase}assets/style.css">
<script src="${assetBase}assets/page.js" defer></script>
</head>
<body>
<a class="skip" href="#status">${e(t("skip"))}</a>
<header class="top">
  <div class="wrap top-inner">
    <a class="brand" href="${e(config.homeUrl)}/">
      <picture>
        <source srcset="${assetBase}assets/logo-on-dark@1x.png 1x, ${assetBase}assets/logo-on-dark@2x.png 2x" media="(prefers-color-scheme: dark)">
        <img src="${assetBase}assets/logo-on-light@1x.png" srcset="${assetBase}assets/logo-on-light@1x.png 1x, ${assetBase}assets/logo-on-light@2x.png 2x" width="80" height="32" alt="Gallafy">
      </picture>
      <span class="brand-tag">${e(t("header.status"))}</span>
    </a>
    <a class="cta" href="${e(config.appUrl)}/">${e(t("header.openApp"))}</a>
  </div>
</header>
<main id="status" class="wrap">
  <section class="overall overall--${model.overall}" aria-live="polite">
    <span class="dot dot--${model.overall}" aria-hidden="true"></span>
    <div>
      <h1>${e(t(`overall.${model.overall}`))}</h1>
      <p class="overall-sub">${e(t(`overall.sub.${model.overall}`))}</p>
      ${checked}
    </div>
  </section>
  ${staleNote}
  ${
    incidents.open.length
      ? `<section class="incidents incidents--open" aria-labelledby="open-title"><h2 id="open-title">${e(t("incidents.open"))}</h2>${open}</section>`
      : ""
  }
  <section aria-labelledby="components-title">
    <h2 id="components-title">${e(t("components.title"))}</h2>
    <p class="muted how">${e(t("howWeCheck"))}</p>
    <ul class="components">
${rows}
    </ul>
    <ul class="legend">${legend}</ul>
    <p class="muted small">${e(t("bars.counted"))}</p>
  </section>
  <section class="incidents" aria-labelledby="past-title">
    <h2 id="past-title">${e(t("incidents.past"))}</h2>
    ${past}
  </section>
  <section class="help" aria-labelledby="help-title">
    <h2 id="help-title">${e(t("help.title"))}</h2>
    <p>${helpHtml}</p>
  </section>
</main>
<footer class="foot">
  <div class="wrap"><p>${e(t("footer.apart"))}</p></div>
</footer>
</body>
</html>
`;
}

function renderRow(r, t, lang, e) {
  const own = `component.${r.id}.line.${r.state}`;
  const stateLine = t.has(own) ? t(own) : t(`line.${r.state}`);
  const line = r.declared ? `${stateLine} ${t("line.declared")}` : stateLine;
  const vendor = r.vendorStatusUrl
    ? ` <a href="${e(r.vendorStatusUrl)}" rel="noopener">${e(t(`component.${r.id}.vendorLink`))}</a>`
    : "";
  const bars = r.bars
    .map((b) => {
      const day = formatDay(b.day, lang);
      const title =
        b.level === "nodata"
          ? t("bars.day.nodata", { day })
          : b.level === "operational"
            ? t("bars.day.operational", { day })
            : t(`bars.day.${b.level}`, {
                day,
                duration: formatDuration(b.level === "down" ? b.down : b.degraded, t),
              });
      return `<span class="bar bar--${b.level}" title="${e(title)}"></span>`;
    })
    .join("");
  const summary = r.uptime === null ? t("bars.noHistory") : t("bars.uptime", { pct: r.uptime });
  return `      <li class="comp" id="${e(r.id)}">
        <div class="comp-head">
          <h3>${e(t(`component.${r.id}.name`))}</h3>
          <span class="chip chip--${r.state}">${e(t(`state.${r.state}`))}</span>
        </div>
        <p class="comp-line">${e(line)}</p>
        <p class="comp-what muted">${e(t(`component.${r.id}.what`))}${vendor}</p>
        <div class="bars" role="img" aria-label="${e(`${t("bars.label")}: ${summary}`)}">${bars}</div>
        <div class="axis muted small" aria-hidden="true"><span><span class="axis-long">${e(t("bars.start"))}</span><span class="axis-short">${e(t("bars.start.phone"))}</span></span><span class="axis-mid">${e(summary)}</span><span>${e(t("bars.end"))}</span></div>
      </li>`;
}

function renderIncident(i, t, lang, names, e) {
  const affects = t("incident.affects", { list: i.components.map((c) => names[c]).join(", ") });
  const when = [
    t("incident.started", { time: formatTime(i.started, lang) }),
    i.resolved ? t("incident.resolved", { time: formatTime(i.resolved, lang) }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const updates = i.updates.map((u) => `<p>${e(u)}</p>`).join("");
  return `<article class="incident incident--${e(i.status)}">
      <div class="incident-head"><h3>${e(i.title)}</h3><span class="chip chip--note">${e(t(`incident.status.${i.status}`))}</span></div>
      <p class="muted small">${e(when)} · ${e(affects)}</p>
      ${updates}
    </article>`;
}
