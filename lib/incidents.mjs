// Incident notes: one Markdown file per incident under incidents/, written by a
// person in GitHub's web editor (docs/adr/0601 §4). The format is deliberately
// tiny so it can be typed on a phone:
//
//   ---
//   title: GST filing is slow
//   components: gsp
//   impact: degraded            # degraded | down | maintenance | none
//   status: investigating       # investigating | identified | monitoring | resolved
//   started: 2026-11-12T10:30+05:30
//   resolved: 2026-11-12T11:10+05:30   # only once status is resolved
//   ---
//   10:45 IST: Sandbox says the GST portal is answering slowly. Filing still works.
//
//   11:10 IST: Back to normal.
//
// The body is shown as plain text, one paragraph per blank-line block. No
// Markdown is rendered and no HTML passes through: every character is escaped.

export const IMPACTS = ["degraded", "down", "maintenance", "none"];
export const STATUSES = ["investigating", "identified", "monitoring", "resolved"];
const REQUIRED = ["title", "components", "impact", "status", "started"];

/**
 * Parse one incident file. Returns `{ incident }` or `{ error }`; never
 * throws, so one bad file is reported and skipped, not a dead page.
 */
export function parseIncident(text, name, componentIds) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { error: `${name}: no front matter between two --- lines` };
  const fields = {};
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 1) return { error: `${name}: cannot read the line "${line}"` };
    fields[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  for (const key of REQUIRED) {
    if (!fields[key]) return { error: `${name}: "${key}" is missing` };
  }
  const components = fields.components
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unknownIds = components.filter((c) => !componentIds.includes(c));
  if (components.length === 0 || unknownIds.length > 0) {
    return {
      error: `${name}: components must be from ${componentIds.join(", ")} (got "${fields.components}")`,
    };
  }
  if (!IMPACTS.includes(fields.impact)) {
    return { error: `${name}: impact must be one of ${IMPACTS.join(", ")}` };
  }
  if (!STATUSES.includes(fields.status)) {
    return { error: `${name}: status must be one of ${STATUSES.join(", ")}` };
  }
  const started = Date.parse(fields.started);
  if (Number.isNaN(started)) return { error: `${name}: started is not a date and time` };
  let resolved = null;
  if (fields.resolved) {
    resolved = Date.parse(fields.resolved);
    if (Number.isNaN(resolved)) return { error: `${name}: resolved is not a date and time` };
  }
  if (fields.status === "resolved" && resolved === null) {
    return { error: `${name}: a resolved incident needs a "resolved" time` };
  }
  const updates = m[2]
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return {
    incident: {
      id: name.replace(/\.md$/, ""),
      title: fields.title,
      components,
      impact: fields.impact,
      status: fields.status,
      started,
      resolved,
      updates,
    },
  };
}

/** Open first (newest first), then resolved ones that started inside the window, newest first. */
export function sortIncidents(incidents, nowMs, windowDays = 90) {
  const since = nowMs - windowDays * 86_400_000;
  const open = incidents.filter((i) => i.status !== "resolved");
  const past = incidents.filter((i) => i.status === "resolved" && i.started >= since);
  const newest = (a, b) => b.started - a.started;
  return { open: open.sort(newest), past: past.sort(newest) };
}
