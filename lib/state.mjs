// The state logic of status.gallafy.com (docs/adr/0601). Pure: no clock, no
// network, no file. `probe.mjs` is the only caller that touches any of those,
// and every rule below is pinned by test/state.test.mjs.
//
// The rules, in one place:
//   - A check is `ok`, `slow` (answered as expected, but after the component's
//     slowMs) or `fail` (timeout, network error, 5xx, or not the answer expected).
//   - A component is the worst of its checks.
//   - DOWN needs two failed runs in a row; one failure changes nothing shown.
//   - DEGRADED needs two slow runs in a row, or one slow answer straight after DOWN.
//   - One good answer is OPERATIONAL again.
//   - Nothing checked for STALE_MS is UNKNOWN, whatever it was before.
//   - An open incident can make a row worse than the probes say, never better.
//   - Time is counted in seconds per IST day. A gap longer than MAX_GAP_S between
//     runs is not counted at all, so a day GitHub skipped is "no data", not "up".

export const STATES = ["operational", "degraded", "down", "maintenance", "unknown"];
export const FAILS_FOR_DOWN = 2;
export const SLOWS_FOR_DEGRADED = 2;
export const STALE_MS = 20 * 60 * 1000;
export const MAX_GAP_S = 15 * 60;
export const HISTORY_DAYS = 90;
const IST_OFFSET_MS = 330 * 60 * 1000;

/**
 * Worse comes later. UNKNOWN outranks slow (we cannot say it is fine), and
 * DOWN outranks UNKNOWN: a part we know is down is never hidden behind one
 * we could not check.
 */
const SEVERITY = { operational: 0, maintenance: 1, degraded: 2, unknown: 3, down: 4 };

export function worst(states) {
  let out = "operational";
  for (const s of states) if (SEVERITY[s] > SEVERITY[out]) out = s;
  return out;
}

/** The IST calendar day a moment falls on, as YYYY-MM-DD. */
export function istDay(ms) {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** `days` IST day keys ending on `todayKey`, oldest first. */
export function lastDays(todayKey, days = HISTORY_DAYS) {
  const end = Date.parse(`${todayKey}T00:00:00Z`);
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    out.push(new Date(end - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * What one HTTP attempt means. `response` is `{ status, contentType, body, ms }`
 * from a request that got an answer, or `{ error: "timeout" | "network", ms }`.
 * Returns `{ outcome, reason }`; `reason` is a fixed code, never response text.
 */
export function classifyResponse(expect, response, slowMs) {
  if (response.error) return { outcome: "fail", reason: response.error };
  const { status } = response;
  if (status >= 500) return { outcome: "fail", reason: `http_${status}` };
  if (!matches(expect, response)) return { outcome: "fail", reason: `unexpected_${status}` };
  if (expect.kind === "app-verdict" && appVerdict(expect, response) === "failing") {
    return { outcome: "fail", reason: "app_saw_failures" };
  }
  if (response.ms > slowMs) return { outcome: "slow", reason: "slow" };
  return { outcome: "ok", reason: "ok" };
}

function matches(expect, { status, contentType, body }) {
  switch (expect.kind) {
    case "status":
      return expect.codes.includes(status);
    case "json-field": {
      if (status !== 200) return false;
      const json = parseJson(body);
      return json !== null && json[expect.field] === expect.value;
    }
    // A front door that answers at all: any status under 500. `answers-json`
    // also wants a JSON body, so a captive portal or a parked domain is a fail.
    case "answers":
      return status < 500;
    case "answers-json":
      return status < 500 && /json/i.test(contentType ?? "") && parseJson(body) !== null;
    // Row 1619: the app's own count of its requests to a government system in
    // the last 15 minutes (`GET /api/health/gst-systems`). A vendor can answer
    // its front door while every e-way bill request times out; only the app
    // sees that. `failing` is classified as a fail above; anything but the
    // three words is an answer we do not understand, so a fail too.
    case "app-verdict":
      return status === 200 && ["ok", "idle", "failing"].includes(appVerdict(expect, { body }));
    default:
      throw new Error(`unknown expect.kind: ${expect.kind}`);
  }
}

function appVerdict(expect, { body }) {
  const json = parseJson(body);
  const systems = json?.systems;
  return systems !== null && typeof systems === "object" ? systems[expect.system] : undefined;
}

function parseJson(text) {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/** A component's outcome is its worst check: one failed check fails it. */
export function combineOutcomes(results) {
  const rank = { ok: 0, slow: 1, fail: 2 };
  return results.reduce((a, b) => (rank[b.outcome] > rank[a.outcome] ? b : a), {
    outcome: "ok",
    reason: "ok",
  });
}

export function emptyComponent() {
  return {
    state: "unknown",
    since: null,
    fails: 0,
    slows: 0,
    lastCheckedAt: null,
    lastReason: null,
    lastMs: null,
    lastInterval: null,
    days: {},
  };
}

/**
 * Fold one run's outcome into a component's record. `prev` is the record
 * from the last run (or `emptyComponent()`), `prevRunAt` the last run's time
 * in ms or null, `nowMs` this run's.
 */
export function advance(prev, result, nowMs, prevRunAt, ms = null) {
  const fails = result.outcome === "fail" ? prev.fails + 1 : 0;
  const slows = result.outcome === "slow" ? prev.slows + 1 : 0;

  let state;
  if (result.outcome === "fail") {
    state = fails >= FAILS_FOR_DOWN ? "down" : prev.state;
  } else if (result.outcome === "slow") {
    state = slows >= SLOWS_FOR_DEGRADED || prev.state === "down" ? "degraded" : "operational";
    if (prev.state === "degraded") state = "degraded";
  } else {
    state = "operational";
  }

  const days = cloneDays(prev.days);
  const today = istDay(nowMs);
  let lastInterval = null;
  if (prevRunAt !== null && nowMs > prevRunAt) {
    const gap = Math.round((nowMs - prevRunAt) / 1000);
    if (gap <= MAX_GAP_S) {
      // Time between two runs is counted in the state this run found. A run's
      // first failure leaves the row as it was, so when the second one makes it
      // DOWN, the interval the first one closed is moved to `down` as well.
      const bucket = state === "unknown" ? null : bucketOf(state);
      if (bucket) {
        add(days, today, bucket, gap);
        lastInterval = { day: today, bucket, seconds: gap };
      }
      if (state === "down" && prev.state !== "down" && prev.lastInterval) {
        const { day, bucket: was, seconds } = prev.lastInterval;
        if (was !== "down" && days[day]?.[was] >= seconds) {
          days[day][was] -= seconds;
          add(days, day, "down", seconds);
        }
      }
    }
  }

  return {
    state,
    since: state === prev.state && prev.since !== null ? prev.since : nowMs,
    fails,
    slows,
    lastCheckedAt: nowMs,
    lastReason: result.reason,
    lastMs: ms,
    lastInterval,
    days: prune(days, today),
  };
}

function bucketOf(state) {
  if (state === "down") return "down";
  if (state === "degraded") return "degraded";
  return "up";
}

function cloneDays(days) {
  const out = {};
  for (const [k, v] of Object.entries(days ?? {})) out[k] = { ...v };
  return out;
}

function add(days, day, bucket, seconds) {
  const d = (days[day] ??= { up: 0, degraded: 0, down: 0 });
  d[bucket] = (d[bucket] ?? 0) + seconds;
}

/** Keep only the last HISTORY_DAYS IST days. */
export function prune(days, todayKey) {
  const keep = new Set(lastDays(todayKey));
  const out = {};
  for (const [k, v] of Object.entries(days)) if (keep.has(k)) out[k] = v;
  return out;
}

/** The incident impacts that can colour a row. `none` is a notice only. */
const IMPACT_STATE = { degraded: "degraded", down: "down", maintenance: "maintenance" };

/**
 * What a row shows now: UNKNOWN when nothing checked it for STALE_MS, else
 * the worst of what the probes found and what an open incident declares.
 */
export function effectiveState(component, id, nowMs, incidents) {
  const stale = component.lastCheckedAt === null || nowMs - component.lastCheckedAt > STALE_MS;
  const probed = stale ? "unknown" : component.state;
  const declared = incidents
    .filter((i) => i.status !== "resolved" && i.components.includes(id))
    .map((i) => IMPACT_STATE[i.impact])
    .filter(Boolean);
  if (declared.length === 0) return probed;
  // A declared state outranks UNKNOWN: a person said what is happening.
  const decl = worst(declared);
  if (probed === "unknown") return decl;
  return worst([probed, decl]);
}

/** One bar per IST day, oldest first. */
export function dayBars(days, todayKey) {
  return lastDays(todayKey).map((day) => {
    const d = days[day];
    const monitored = d ? d.up + d.degraded + d.down : 0;
    if (!monitored) return { day, level: "nodata", pct: null, down: 0, degraded: 0 };
    const level = d.down > 0 ? "down" : d.degraded > 0 ? "degraded" : "operational";
    return { day, level, pct: (d.up + d.degraded) / monitored, down: d.down, degraded: d.degraded };
  });
}

/** Share of monitored time the component answered, over every kept day; null with no data. */
export function uptime(days) {
  let up = 0;
  let all = 0;
  for (const d of Object.values(days)) {
    up += d.up + d.degraded;
    all += d.up + d.degraded + d.down;
  }
  return all === 0 ? null : up / all;
}

/** Floored, never rounded up: 99.996% is "99.99%", and only a clean record reads "100%". */
export function formatPct(fraction) {
  if (fraction === null) return null;
  if (fraction >= 1) return "100%";
  const floored = Math.floor(fraction * 10_000) / 100;
  return `${floored.toFixed(2)}%`;
}

/** The whole page's headline state, over the rows the page shows. */
export function overallState(rowStates) {
  if (rowStates.length === 0) return "unknown";
  return worst(rowStates);
}
