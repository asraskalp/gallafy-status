// The state logic's rules (lib/state.mjs header), one test per rule.
// Runs with no dependency: `node --test test/`.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  HISTORY_DAYS,
  MAX_GAP_S,
  STALE_MS,
  advance,
  classifyResponse,
  combineOutcomes,
  dayBars,
  effectiveState,
  emptyComponent,
  formatPct,
  istDay,
  overallState,
  prune,
  uptime,
} from "../lib/state.mjs";

const T0 = Date.parse("2026-11-12T06:00:00Z"); // 11:30 IST
const MIN = 60_000;
const OK = { outcome: "ok", reason: "ok" };
const FAIL = { outcome: "fail", reason: "timeout" };
const SLOW = { outcome: "slow", reason: "slow" };

/** Feed outcomes five minutes apart from T0; returns every intermediate record. */
function run(outcomes, start = emptyComponent()) {
  const out = [];
  let rec = start;
  let prevRunAt = null;
  outcomes.forEach((o, i) => {
    const now = T0 + i * 5 * MIN;
    rec = advance(rec, o, now, prevRunAt);
    prevRunAt = now;
    out.push(rec);
  });
  return out;
}

describe("classifyResponse", () => {
  const health = { kind: "json-field", field: "status", value: "ok" };
  const answer = (status, body, contentType = "application/json", ms = 100) => ({
    status,
    body,
    contentType,
    ms,
  });

  it("a timeout or a network error is a fail, with a fixed reason", () => {
    assert.deepEqual(classifyResponse(health, { error: "timeout", ms: 10000 }, 4000), {
      outcome: "fail",
      reason: "timeout",
    });
    assert.equal(classifyResponse(health, { error: "network", ms: 3 }, 4000).reason, "network");
  });

  it("any 5xx is a fail, whatever the expectation", () => {
    for (const expect of [health, { kind: "answers" }, { kind: "answers-json" }]) {
      assert.equal(classifyResponse(expect, answer(503, "{}"), 4000).outcome, "fail");
    }
  });

  it("json-field wants a 200 whose field holds the value", () => {
    assert.equal(classifyResponse(health, answer(200, '{"status":"ok"}'), 4000).outcome, "ok");
    assert.equal(
      classifyResponse(health, answer(200, '{"status":"unavailable"}'), 4000).outcome,
      "fail",
    );
    assert.equal(classifyResponse(health, answer(200, "<html>"), 4000).outcome, "fail");
    assert.equal(
      classifyResponse(health, answer(404, '{"status":"ok"}'), 4000).reason,
      "unexpected_404",
    );
  });

  it("status wants one of the listed codes", () => {
    const page = { kind: "status", codes: [200] };
    assert.equal(classifyResponse(page, answer(200, "<html>", "text/html"), 4000).outcome, "ok");
    assert.equal(classifyResponse(page, answer(404, "", "text/html"), 4000).outcome, "fail");
  });

  it("answers-json: a vendor's front door refusing us in JSON is reachable; an HTML page is not", () => {
    const door = { kind: "answers-json" };
    // What api.sandbox.co.in/ answers with no key (2026-11-12): 403, JSON.
    const sandbox = answer(403, '{"code":403,"message":"Missing Authentication Token"}');
    assert.equal(classifyResponse(door, sandbox, 6000).outcome, "ok");
    assert.equal(classifyResponse(door, answer(200, "<html>", "text/html"), 6000).outcome, "fail");
    assert.equal(
      classifyResponse({ kind: "answers" }, answer(404, "", "text/xml"), 6000).outcome,
      "ok",
    );
  });

  it("app-verdict: the app's own count decides, not the vendor's front door (row 1619)", () => {
    const eway = { kind: "app-verdict", system: "eway" };
    const said = (systems, status = 200) =>
      answer(status, JSON.stringify({ status: "ok", windowMinutes: 15, systems }));
    assert.equal(classifyResponse(eway, said({ eway: "ok" }), 4000).outcome, "ok");
    assert.equal(classifyResponse(eway, said({ eway: "idle" }), 4000).outcome, "ok");
    // 2026-11-12: Generate answered "The e-way bill system did not answer" while
    // Sandbox's front door answered. Only this check sees it.
    assert.deepEqual(classifyResponse(eway, said({ eway: "failing", einvoice: "ok" }), 4000), {
      outcome: "fail",
      reason: "app_saw_failures",
    });
    assert.equal(classifyResponse(eway, said({ einvoice: "ok" }), 4000).outcome, "fail");
    assert.equal(classifyResponse(eway, said({ eway: "maybe" }), 4000).outcome, "fail");
    assert.equal(classifyResponse(eway, said({ eway: "ok" }, 404), 4000).outcome, "fail");
    assert.equal(
      classifyResponse(eway, answer(503, '{"status":"unavailable"}'), 4000).outcome,
      "fail",
    );
  });

  it("an expected answer after slowMs is slow, not ok", () => {
    assert.equal(
      classifyResponse(health, answer(200, '{"status":"ok"}', "application/json", 4001), 4000)
        .outcome,
      "slow",
    );
  });

  it("an unknown expectation is a programming error, not a silent pass", () => {
    assert.throws(() => classifyResponse({ kind: "nope" }, answer(200, ""), 1), /unknown expect/);
  });
});

describe("combineOutcomes", () => {
  it("a component is its worst check", () => {
    assert.equal(combineOutcomes([OK, SLOW]).outcome, "slow");
    assert.equal(combineOutcomes([OK, FAIL, SLOW]).outcome, "fail");
    assert.equal(combineOutcomes([OK, OK]).outcome, "ok");
  });
});

describe("advance: two failures before down", () => {
  it("one failure changes nothing shown; the second makes it DOWN", () => {
    const [a, b, c] = run([OK, FAIL, FAIL]);
    assert.equal(a.state, "operational");
    assert.equal(b.state, "operational");
    assert.equal(c.state, "down");
  });

  it("a failure between two good answers never shows DOWN", () => {
    const states = run([OK, FAIL, OK, FAIL, OK]).map((r) => r.state);
    assert.deepEqual(states, Array(5).fill("operational"));
  });

  it("one good answer is OPERATIONAL again", () => {
    assert.equal(run([OK, FAIL, FAIL, FAIL, OK]).at(-1).state, "operational");
  });

  it("a first-ever failure is UNKNOWN, not working and not down", () => {
    assert.deepEqual(
      run([FAIL, FAIL]).map((r) => r.state),
      ["unknown", "down"],
    );
  });

  it("two slow runs make it DEGRADED; one does not", () => {
    assert.deepEqual(
      run([OK, SLOW, SLOW, OK]).map((r) => r.state),
      ["operational", "operational", "degraded", "operational"],
    );
  });

  it("a slow answer straight after DOWN is DEGRADED: it answers, but not well", () => {
    assert.equal(run([OK, FAIL, FAIL, SLOW]).at(-1).state, "degraded");
  });

  it("`since` moves only when the state changes", () => {
    const recs = run([OK, OK, FAIL, FAIL, FAIL]);
    assert.equal(recs[1].since, T0);
    assert.equal(recs[3].since, T0 + 15 * MIN);
    assert.equal(recs[4].since, T0 + 15 * MIN);
  });
});

describe("advance: counting time", () => {
  it("each interval is counted in the state the run found", () => {
    const rec = run([OK, OK, OK]).at(-1);
    assert.deepEqual(rec.days[istDay(T0)], { up: 600, degraded: 0, down: 0 });
  });

  it("when DOWN is confirmed, the interval the first failure closed moves to down", () => {
    const rec = run([OK, OK, FAIL, FAIL]).at(-1);
    // Intervals: OK→OK up 300; OK→FAIL (first fail) 300, moved to down; FAIL→FAIL down 300.
    assert.deepEqual(rec.days[istDay(T0)], { up: 300, degraded: 0, down: 600 });
  });

  it("a gap longer than MAX_GAP_S between runs is not counted at all", () => {
    const first = advance(emptyComponent(), OK, T0, null);
    const late = T0 + (MAX_GAP_S + 1) * 1000;
    const rec = advance(first, OK, late, T0);
    assert.equal(rec.days[istDay(late)], undefined);
    assert.equal(rec.state, "operational");
  });

  it("the first run counts nothing: there is no interval yet", () => {
    assert.deepEqual(advance(emptyComponent(), OK, T0, null).days, {});
  });

  it("days are IST days: 23:59 IST and 00:01 IST fall on different days", () => {
    assert.equal(istDay(Date.parse("2026-11-12T18:29:00Z")), "2026-11-12");
    assert.equal(istDay(Date.parse("2026-11-12T18:31:00Z")), "2026-11-13");
  });

  it("only the last HISTORY_DAYS days are kept", () => {
    const days = {};
    for (let i = 0; i < 120; i += 1) {
      days[istDay(T0 - i * 86_400_000)] = { up: 1, degraded: 0, down: 0 };
    }
    const kept = prune(days, istDay(T0));
    assert.equal(Object.keys(kept).length, HISTORY_DAYS);
    assert.ok(kept[istDay(T0)]);
    assert.equal(kept[istDay(T0 - HISTORY_DAYS * 86_400_000)], undefined);
  });
});

describe("effectiveState", () => {
  const fresh = { ...emptyComponent(), state: "operational", lastCheckedAt: T0 };
  const incident = (over) => ({
    components: ["gsp"],
    impact: "degraded",
    status: "investigating",
    ...over,
  });

  it("nothing checked for STALE_MS is UNKNOWN, whatever it was", () => {
    assert.equal(effectiveState(fresh, "gsp", T0 + STALE_MS, []), "operational");
    assert.equal(effectiveState(fresh, "gsp", T0 + STALE_MS + 1, []), "unknown");
    assert.equal(effectiveState(emptyComponent(), "gsp", T0, []), "unknown");
  });

  it("an open incident can make a row worse than the probes say", () => {
    assert.equal(effectiveState(fresh, "gsp", T0, [incident()]), "degraded");
  });

  it("an incident never makes a row better than the probes say", () => {
    const down = { ...fresh, state: "down" };
    assert.equal(effectiveState(down, "gsp", T0, [incident({ impact: "maintenance" })]), "down");
  });

  it("a resolved incident, another component's, or impact none changes nothing", () => {
    assert.equal(
      effectiveState(fresh, "gsp", T0, [incident({ status: "resolved" })]),
      "operational",
    );
    assert.equal(
      effectiveState(fresh, "gsp", T0, [incident({ components: ["website"] })]),
      "operational",
    );
    assert.equal(effectiveState(fresh, "gsp", T0, [incident({ impact: "none" })]), "operational");
  });

  it("a person's note outranks UNKNOWN: stale checks with a posted outage read DOWN", () => {
    assert.equal(
      effectiveState(fresh, "gsp", T0 + STALE_MS + 1, [incident({ impact: "down" })]),
      "down",
    );
  });
});

describe("bars, uptime and the headline", () => {
  const today = istDay(T0);

  it("90 bars, oldest first, today last; a day with no data is nodata, not up", () => {
    const bars = dayBars({ [today]: { up: 300, degraded: 0, down: 0 } }, today);
    assert.equal(bars.length, 90);
    assert.equal(bars.at(-1).day, today);
    assert.equal(bars.at(-1).level, "operational");
    assert.equal(bars[0].level, "nodata");
    assert.equal(bars[0].pct, null);
  });

  it("any down time makes the day's bar down; else any slow time makes it degraded", () => {
    assert.equal(
      dayBars({ [today]: { up: 9000, degraded: 300, down: 300 } }, today).at(-1).level,
      "down",
    );
    assert.equal(
      dayBars({ [today]: { up: 9000, degraded: 300, down: 0 } }, today).at(-1).level,
      "degraded",
    );
  });

  it("uptime counts slow time as up, and only monitored time at all", () => {
    assert.equal(uptime({ a: { up: 700, degraded: 200, down: 100 } }), 0.9);
    assert.equal(uptime({}), null);
  });

  it("percentages are floored, so only a clean record reads 100%", () => {
    assert.equal(formatPct(0.99996), "99.99%");
    assert.equal(formatPct(0.999999), "99.99%");
    assert.equal(formatPct(1), "100%");
    assert.equal(formatPct(0.5), "50.00%");
    assert.equal(formatPct(null), null);
  });

  it("the headline is the worst row: DOWN is never hidden behind UNKNOWN, UNKNOWN beats slow", () => {
    assert.equal(overallState(["operational", "operational"]), "operational");
    assert.equal(overallState(["operational", "degraded"]), "degraded");
    assert.equal(overallState(["degraded", "down"]), "down");
    assert.equal(overallState(["down", "unknown"]), "down");
    assert.equal(overallState(["degraded", "unknown"]), "unknown");
    assert.equal(overallState(["operational", "maintenance"]), "maintenance");
    assert.equal(overallState([]), "unknown");
  });
});
