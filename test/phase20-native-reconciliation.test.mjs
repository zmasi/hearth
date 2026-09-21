import assert from "node:assert/strict";
import test from "node:test";
import { initialState, validateConsent } from "../client/habitation.mjs";
import { nativeTick, releaseVisit } from "../client/habitation-visit.mjs";
import { observeVisit } from "../client/habitation-seat.mjs";
import { startFixtureSeat } from "../test-support/a2a-fixture-seat.mjs";

const T0 = "2026-09-20T12:00:00.000Z", T1 = "2026-09-20T12:01:00.000Z";
const makeConsent = seat => validateConsent({ schema: "hearth-habitation-consent-v1", handle: "resident_probe",
  origin: "https://hearth.example", key_file: "synthetic.key", enabled: true,
  budget: { max_wakes_per_day: 4, cooldown_minutes: 0 },
  seat: { url: seat.url, expect_name: "fixture-seat", continuity: "continuing" } });
function cityFetch(url, init) {
  if (!String(url).startsWith("https://hearth.example")) return fetch(url, init);
  const after = Number(new URL(url).searchParams.get("after"));
  return Promise.resolve({ status: 200, json: async () => ({ ok: true, schema_version: "hearth-perception-v1",
    handle: "resident_probe", after, world_sequence: 1, next_after: 1, chained: true, truncated: false,
    events: after ? [] : [{ seq: 1, actorHandle: "neighbour", placeId: "arrival", kind: "say" }],
    mentions: after ? [] : [{ id: "note_1", seq: 1, authorHandle: "neighbour", placeId: "arrival" }] }) });
}
function store() {
  const out = { state: initialState(), writes: 0 };
  out.persist = async state => { out.writes++; out.state = structuredClone(state); };
  return out;
}
const tick = (consent, saved, extra = {}) => nativeTick({ consent, state: saved.state, persist: saved.persist,
  fetchImpl: cityFetch, readKey: async () => "synthetic", now: T0, ...extra });

test("lost acknowledgment never redirects an unresolved intent to another resident, world, receiver or continuity lane", async t => {
  const a = await startFixtureSeat(), b = await startFixtureSeat();
  t.after(async () => { await a.close(); await b.close(); });
  const consent = makeConsent(a), saved = store();
  await assert.rejects(tick(consent, saved, { persist: async next => {
    if (next.visit?.phase !== "pending") throw new Error("simulated acknowledgment save failure");
    await saved.persist(next);
  } }), /acknowledgment save failure/);
  assert.equal(a.admissions, 1);
  assert.equal(saved.state.visit.phase, "pending");
  const pending = structuredClone(saved.state), beforeWrites = saved.writes;
  const changed = [
    { ...consent, seat: { ...consent.seat, url: b.url } },
    { ...consent, handle: "someone_else" },
    { ...consent, origin: "https://another.example" },
    { ...consent, seat: { ...consent.seat, continuity: "fresh" } },
    { ...consent, seat: { ...consent.seat, expect_name: "other-seat" } },
  ];
  for (const other of changed) {
    let requests = 0;
    const result = await tick(other, saved, { now: T1, fetchImpl: async (...args) => { requests++; return cityFetch(...args); } });
    assert.equal(result.outcome, "deferred");
    assert.equal(result.reason, "visit_binding_changed");
    assert.equal(requests, 0, "even task observation must not go to a different receiver");
    assert.deepEqual(saved.state, pending);
  }
  assert.equal(b.admissions, 0);
  assert.equal(saved.writes, beforeWrites);
  const recovered = await tick(consent, saved, { now: T1 });
  assert.equal(recovered.outcome, "accepted");
  assert.equal(a.admissions, 1, "same-receiver retry is exact replay, not a new execution");
  assert.equal(saved.state.wakes.length, 1);
  assert.equal(saved.state.visit.id, pending.visit.id);
});

test("an admitted task disappearing holds its exact identity until explicit release, never infers completion", async t => {
  const seat = await startFixtureSeat(); t.after(() => seat.close());
  const consent = makeConsent(seat), saved = store();
  await tick(consent, saved);
  const before = structuredClone(saved.state), beforeWrites = saved.writes;
  seat.forget(before.visit.task_id);
  for (let retry = 0; retry < 2; retry++) {
    const result = await tick(consent, saved, { now: T1 });
    assert.equal(result.outcome, "deferred");
    assert.equal(result.reason, "visit_unresolved");
    assert.equal(result.ended, undefined);
    assert.deepEqual(saved.state, before);
  }
  assert.equal(seat.admissions, 1);
  assert.equal(saved.writes, beforeWrites);
  await saved.persist(releaseVisit(saved.state, T1));
  assert.equal(saved.state.visit.native_state, "RELEASED_BY_RESIDENT");
  assert.equal((await tick(consent, saved, { now: T1 })).outcome, "accepted");
  assert.equal(seat.admissions, 2, "a replacement is possible only after the explicit release decision");
});

test("task observations must match the original habitation context as well as task ID", async t => {
  const seat = await startFixtureSeat(); t.after(() => seat.close());
  const consent = makeConsent(seat), saved = store();
  await tick(consent, saved);
  const before = structuredClone(saved.state), visit = saved.state.visit;
  seat.tasks.get(visit.task_id).contextId = "wrong-context";
  await assert.rejects(observeVisit({ seat: consent.seat, task_id: visit.task_id, context_id: visit.context_id }), { code: "seat_bad_response" });
  const result = await tick(consent, saved, { now: T1 });
  assert.equal(result.reason, "seat_bad_response");
  assert.equal(result.ended, undefined);
  assert.deepEqual(saved.state, before);
  assert.equal(seat.admissions, 1);
});

test("unresolved pre-binding state is held for reconciliation rather than silently rebound", async t => {
  const seat = await startFixtureSeat(); t.after(() => seat.close());
  const consent = makeConsent(seat), saved = store();
  await tick(consent, saved);
  delete saved.state.visit.binding;
  const before = structuredClone(saved.state);
  let requests = 0;
  const result = await tick(consent, saved, { fetchImpl: async () => { requests++; throw new Error("no request expected"); } });
  assert.equal(result.outcome, "deferred");
  assert.equal(result.reason, "visit_binding_changed");
  assert.equal(requests, 0);
  assert.deepEqual(saved.state, before);
});
