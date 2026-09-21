import assert from "node:assert/strict";
import test from "node:test";
import { initialState, readPerception, runOnce, validateConsent } from "../client/habitation.mjs";
import { nativeTick } from "../client/habitation-visit.mjs";

const consent = validateConsent({ schema: "hearth-habitation-consent-v1", handle: "reader_probe",
  origin: "https://hearth.example", key_file: "synthetic.key", enabled: true,
  seat: { url: "http://127.0.0.1:9916", expect_name: "fixture" } });
const event = seq => ({ seq, kind: "say", actorHandle: "neighbour", placeId: "arrival" });
const mention = seq => ({ seq, id: `note_${seq}`, authorHandle: "neighbour", placeId: "arrival" });
const page = (after = 0, head = 1) => ({ ok: true, schema_version: "hearth-perception-v1", handle: consent.handle,
  after, world_sequence: head, next_after: head, chained: true, truncated: false,
  events: Array.from({ length: head - after }, (_, i) => event(after + i + 1)), mentions: [mention(head)] });
const reply = (body, status = 200) => ({ status, json: async () => structuredClone(body) });

const malformed = {
  "wrong resident": p => { p.handle = "someone_else"; },
  "wrong schema": p => { p.schema_version = "unknown-v99"; },
  "wrong cursor": p => { p.after = 91; },
  "missing cursor": p => { delete p.after; },
  "unsafe head": p => { p.world_sequence = Number.MAX_SAFE_INTEGER + 1; },
  "backward head": p => { p.world_sequence = -1; },
  "cursor beyond head": p => { p.next_after = 2; },
  "backward next cursor": p => { p.next_after = -1; },
  "unsequenced events": p => { delete p.events[0].seq; },
  "event beyond window": p => { p.events[0].seq = 2; },
  "duplicate events": p => { p.events.push(structuredClone(p.events[0])); },
  "non-array events": p => { p.events = {}; },
  "non-array mentions": p => { p.mentions = null; },
  "mention beyond window": p => { p.mentions[0].seq = 2; },
  "unmarked legacy mention": p => { delete p.mentions[0].seq; },
  "missing truncated flag": p => { delete p.truncated; },
  "false chain": p => { p.chained = false; },
  "truncated at head": p => { p.truncated = true; },
  "untruncated before head": p => { p.world_sequence = 2; },
};

for (const [name, mutate] of Object.entries(malformed)) {
  test(`perception refuses ${name} before either dispatch path or state writes`, async () => {
    const broken = page(); mutate(broken);
    let dispatches = 0, saves = 0, seatRequests = 0;
    const fetchImpl = async url => {
      assert.ok(String(url).startsWith(consent.origin), "invalid perception must not contact the native seat");
      if (!String(url).startsWith(consent.origin)) seatRequests++;
      return reply(broken);
    };
    const state = initialState();
    const common = { consent, state, fetchImpl, readKey: async () => "synthetic", now: "2026-09-20T12:00:00.000Z" };
    await assert.rejects(runOnce({ ...common, activate: true, dispatch: async () => dispatches++ }), { code: "bad_perception" });
    await assert.rejects(nativeTick({ ...common, persist: async () => saves++ }), { code: "bad_perception" });
    assert.equal(dispatches + saves + seatRequests, 0);
    assert.deepEqual(state, initialState());
  });
}

test("perception validates every page, not just the final aggregated page", async () => {
  const first = { ...page(), world_sequence: 2, truncated: true };
  for (const property of ["handle", "schema_version", "after"]) {
    let reads = 0;
    const second = page(1, 2); second[property] = property === "after" ? 0 : "wrong";
    await assert.rejects(readPerception({ consent, key: "synthetic", after: 0,
      fetchImpl: async () => reply(++reads === 1 ? first : second) }), { code: "bad_perception" });
    assert.equal(reads, 2);
  }
});

test("perception accepts valid multi-page contract, legacy first-page mention and quiet head", async () => {
  const first = { ...page(), world_sequence: 2, truncated: true };
  first.mentions.push({ id: "legacy_note", legacy: true, authorHandle: "neighbour", placeId: "arrival" });
  const second = page(1, 2);
  let reads = 0, dispatches = 0;
  const result = await runOnce({ consent, state: initialState(), readKey: async () => "synthetic", activate: true,
    fetchImpl: async url => { assert.equal(new URL(url).searchParams.get("after"), String(reads)); return reply(++reads === 1 ? first : second); },
    dispatch: async () => dispatches++ });
  assert.equal(dispatches, 1);
  assert.equal(result.state.after, 2);
  assert.equal(result.packet.triggers.length, 3);
  const quiet = await readPerception({ consent, key: "synthetic", after: 2,
    fetchImpl: async () => reply({ ...page(2, 2), mentions: [] }) });
  assert.equal(quiet.perception.next_after, 2);
});

test("cursor-ahead resets require a valid head strictly behind the requested cursor", async () => {
  for (const head of [-1, 2, 3, "1", Number.MAX_SAFE_INTEGER + 1, undefined]) {
    await assert.rejects(readPerception({ consent, key: "synthetic", after: 2,
      fetchImpl: async () => reply({ ok: false, error_class: "cursor_ahead", world_sequence: head }, 400) }), { code: "bad_perception" });
  }
  const result = await readPerception({ consent, key: "synthetic", after: 2,
    fetchImpl: async () => reply({ ok: false, error_class: "cursor_ahead", world_sequence: 1 }, 400) });
  assert.equal(result.cursorAhead, 1);
});
