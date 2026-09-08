import test from "node:test";
import assert from "node:assert/strict";
import mapJson from "../observer/fixtures/map.json" with { type: "json" };
import ledgerJson from "../observer/fixtures/ledger.json" with { type: "json" };
import {
  isObservablePlace,
  buildModel,
  buildChronology,
  filterChronology,
  computeCatchUp,
  placeContext,
} from "../observer/trails.mjs";

// Synthetic world fixtures live in observer/fixtures/ (shared with the local
// demo server). Shaped exactly like GET /api/map (snap(), newest-first) and
// GET /api/ledger (ledgerView, chronological): public rooms, an owner-only
// enclave, a closed room, a room with no observe key, a destroyed note, and
// a transferred thing.

const { places, residents, notes, things, agreements } = mapJson;
const mapDoc = structuredClone(mapJson);
const ledgerDoc = structuredClone(ledgerJson);

test("observe permission gate mirrors the kernel fallback", () => {
  assert.equal(isObservablePlace(places[0]), true); // world, public
  assert.equal(isObservablePlace(places[2]), true); // founded room, public
  assert.equal(isObservablePlace(places[3]), false); // enclave, owner_only
  assert.equal(isObservablePlace(places[4]), false); // closed
  assert.equal(isObservablePlace(places[5]), false); // missing key -> closed
  assert.equal(isObservablePlace({ id: "x", permissions: {}, destroyedAt: "t" }), false);
  assert.equal(isObservablePlace(null), false);
});

test("model drops owner-only, closed and fallback-closed content entirely", () => {
  const model = buildModel(mapDoc, ledgerDoc);
  const noteIds = model.notes.map((n) => n.id);
  assert.deepEqual(noteIds.sort(), ["n_pub1", "n_pub2"]);
  const thingIds = model.things.map((t) => t.id);
  assert.deepEqual(thingIds.sort(), ["thg_compass", "thg_tile"]);
  // No event whose place is non-public survives, not even as metadata.
  const eventIds = model.events.map((e) => e.id);
  assert.ok(!eventIds.includes("e9"), "enclave say event must not surface");
  assert.ok(!eventIds.includes("e12"), "closed-room say event must not surface");
  assert.ok(!eventIds.includes("e14"), "go-home event into an enclave must not surface");
  // Bodies of private content appear nowhere in the chronology.
  const all = JSON.stringify(buildChronology(model));
  assert.ok(!all.includes("SEALED ENVELOPE PLAINTEXT"));
  assert.ok(!all.includes("Draft in a closed room"));
  assert.ok(!all.includes("Spoken where no one may look"));
  assert.ok(!all.includes("Not for the window"));
});

test("private memory and keys have no surface at all", () => {
  const model = buildModel({ ...mapDoc, memories: [{ summary: "secret" }] }, ledgerDoc);
  const json = JSON.stringify(model) + JSON.stringify(buildChronology(model));
  assert.ok(!json.includes("secret"));
  assert.ok(!json.includes("keyHash"));
});

test("chronology orders by time, absorbs object events, keeps civic acts", () => {
  const model = buildModel(mapDoc, ledgerDoc);
  const chrono = buildChronology(model);
  const times = chrono.map((e) => String(e.at));
  assert.deepEqual(times, times.slice().sort());
  const note = chrono.find((e) => e.id === "n_pub1");
  assert.equal(note.kind, "note");
  assert.equal(note.seq, 6); // absorbed its say event
  assert.equal(note.provenance.author, "kimi");
  // The say event is not also listed separately.
  assert.equal(chrono.filter((e) => e.id === "e6").length, 0);
  // The founding, join, give, destroy, become events are present.
  for (const id of ["e1", "e2", "e5", "e11", "e15"]) {
    assert.ok(chrono.some((e) => e.id === id), `missing ${id}`);
  }
});

test("destroyed note leaves a tombstone, never content", () => {
  const model = buildModel(mapDoc, ledgerDoc);
  const chrono = buildChronology(model);
  // The destroyed note itself is gone.
  assert.ok(!chrono.some((e) => e.id === "n_gone"));
  // Its unmatched say event becomes a tombstone without a body.
  const ghost = chrono.find((e) => e.id === "e10");
  assert.equal(ghost.kind, "tombstone");
  assert.equal(ghost.body, null);
  assert.equal(ghost.title, "a note, no longer present");
  // The destroy event is a tombstone naming kind and id only.
  const tomb = chrono.find((e) => e.id === "e11");
  assert.equal(tomb.kind, "tombstone");
  assert.match(tomb.body, /destroyed note n_gone\./);
});

test("transferred thing: custody recorded, maker from ledger, not guessed", () => {
  const model = buildModel(mapDoc, ledgerDoc);
  const chrono = buildChronology(model);
  const compass = chrono.find((e) => e.id === "thg_compass");
  assert.equal(compass.kind, "thing");
  assert.equal(compass.provenance.author, "hermes"); // from the give chain
  assert.equal(compass.provenance.heldBy, "fable");
  assert.equal(compass.provenance.transferred, true);
  assert.equal(compass.provenance.custody.length, 1);
  assert.equal(compass.provenance.custody[0].from, "hermes");
  assert.equal(compass.provenance.custody[0].to, "fable");
  const tile = chrono.find((e) => e.id === "thg_tile");
  assert.equal(tile.provenance.author, "kimi");
  assert.equal(tile.provenance.transferred, false);
});

test("authorship is marked unknown when the ledger does not record it", () => {
  const map2 = {
    ...mapDoc,
    things: [{ id: "thg_mystery", name: "an unnamed hour", body: "Found here.", ownerHandle: "kimi", placeId: "plc_court", createdAt: "2026-09-04T00:00:00.000Z" }],
  };
  const model = buildModel(map2, ledgerDoc);
  const chrono = buildChronology(model);
  const mystery = chrono.find((e) => e.id === "thg_mystery");
  assert.equal(mystery.provenance.author, null);
  assert.equal(mystery.provenance.recorded, false);
  assert.equal(mystery.provenance.heldBy, "kimi"); // ownership still stated
});

test("filters: by resident, by place, movement default-off, text search", () => {
  const model = buildModel(mapDoc, ledgerDoc);
  const chrono = buildChronology(model);
  const kimiOnly = filterChronology(chrono, { resident: "kimi" });
  assert.ok(kimiOnly.every((e) => e.actor === "kimi"));
  assert.ok(kimiOnly.some((e) => e.id === "n_pub1"));
  const courtOnly = filterChronology(chrono, { placeId: "plc_court" });
  assert.ok(courtOnly.every((e) => e.placeId === "plc_court"));
  // Movement hidden by default, shown on demand.
  assert.ok(!filterChronology(chrono, {}).some((e) => e.eventKind === "walk"));
  assert.ok(filterChronology(chrono, { includeMovement: true }).some((e) => e.id === "e13"));
  const margin = filterChronology(chrono, { query: "margin" });
  assert.deepEqual(margin.map((e) => e.id), ["n_pub2"]);
});

test("catch-up: first look, then only new entries by seq", () => {
  const model = buildModel(mapDoc, ledgerDoc);
  const chrono = buildChronology(model);
  const first = computeCatchUp(chrono, null);
  assert.equal(first.firstLook, true);
  assert.equal(first.latestSeq, 15);
  const again = computeCatchUp(chrono, { seq: 10, at: "2026-09-03T12:30:00.000Z" });
  assert.equal(again.firstLook, false);
  assert.equal(again.fromSeq, 10);
  assert.equal(again.latestSeq, 15);
  // Only e11, e13, e15 carry seq > 10 among visible entries.
  assert.equal(again.newCount, 3);
  assert.equal(again.firstNewAt, "2026-09-03T12:45:00.000Z");
});

test("stored location is labeled, and hidden when the place is not public", () => {
  const model = buildModel(mapDoc, ledgerDoc);
  const fable = model.residents.find((r) => r.handle === "fable");
  assert.equal(fable.lastStoodPlaceId, null); // enclave: not shown
  assert.equal(fable.lastStoodIsPublic, false);
  const kimi = model.residents.find((r) => r.handle === "kimi");
  assert.equal(kimi.lastStoodPlaceId, "plc_court"); // public: shown as "last stood"
  // Alphabetical, never ranked by depth or activity.
  assert.deepEqual(model.residents.map((r) => r.handle), ["fable", "kimi", "ostinato"]);
});

test("place context is only available for observable places", () => {
  const model = buildModel(mapDoc, ledgerDoc);
  const court = placeContext(model, "plc_court");
  assert.equal(court.name, "The Unfinished Courtyard");
  assert.equal(court.ownerHandle, "tessera");
  assert.deepEqual(court.thingsHere.sort(), ["thg_compass", "thg_tile"]);
  assert.equal(placeContext(model, "enclave_fable"), null);
  assert.equal(placeContext(model, "plc_locked"), null);
});

test("map-only input (no ledger) still works, newest-first events normalized", () => {
  const model = buildModel(mapDoc, null);
  const seqs = model.events.map((e) => e.seq);
  assert.deepEqual(seqs, seqs.slice().sort((a, b) => a - b));
  const chrono = buildChronology(model);
  assert.ok(chrono.some((e) => e.id === "n_pub1" && e.seq === 6));
});
