import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  MACHINE_OPS,
  MECHANISM_BOUNDS,
  normalizeMachineStep,
  publicFields,
  runMachineStep,
} from "../client/pin-machines.mjs";

function worldWith(thingFields = undefined, extraThings = []) {
  return {
    places: [{ id: "room", name: "Channel", ownerHandle: "alice_probe" }],
    things: [
      { id: "weir", name: "weir", body: "a gate", ownerHandle: "alice_probe", placeId: "room", ...(thingFields ? { fields: thingFields } : {}) },
      ...extraThings,
    ],
  };
}

function runtime(world, instruction, extra = {}) {
  return runMachineStep({
    instruction,
    env: { caller: "bob_probe", place: "room", target: "weir", verb: "crank", ...(extra.env || {}) },
    world,
    standingId: extra.standingId || "room",
    pinTargetId: extra.pinTargetId || "weir",
    now: extra.now || "2026-10-24T00:00:00.000Z",
    readPhysical: extra.readPhysical || null,
  });
}

test("pin-machines: host escape, physical writes, and unnamed fields are rejected at pin time", () => {
  assert.equal(normalizeMachineStep({ do: "eval", code: "1" }).ok, false);
  assert.equal(normalizeMachineStep({ do: "set", field: "open", to: "1", module: "node:fs" }).ok, false);
  assert.equal(normalizeMachineStep({ do: "set", field: "open", to: "1", bag: "physical" }).ok, false);
  assert.equal(normalizeMachineStep({ do: "add", field: "Open", by: "1" }).ok, false);
  assert.equal(normalizeMachineStep({ do: "require", field: "open", eq: "1", gte: "0" }).ok, false);
  assert.equal(normalizeMachineStep({ do: "set", field: "open", to: 1 }).ok, false);
  const okSet = normalizeMachineStep({ do: "set", field: "open", to: "1" });
  assert.equal(okSet.ok, true);
  assert.deepEqual(okSet.instruction, { do: "set", field: "open", to: "1" });
});

test("pin-machines: missing fields and unwired physical sensors fail closed, never as zero", () => {
  const world = worldWith();
  const requireZero = runtime(world, { do: "require", field: "charge", eq: "0" });
  assert.equal(requireZero.ok, false);
  assert.equal(requireZero.cause.error_class, "guard_failed");
  assert.equal(requireZero.http_status, 409);
  assert.equal(world.things[0].fields, undefined);

  const whenMissing = runtime(world, { do: "when", field: "charge", gte: "3" });
  assert.equal(whenMissing.ok, true);
  assert.equal(whenMissing.skipRest, true);

  const physical = runtime(world, { do: "require", field: "level", bag: "physical", gte: "1" });
  assert.equal(physical.ok, false);
  assert.equal(physical.cause.error_class, "guard_failed");
  assert.match(physical.message, /physical|sensor|wired/i);

  const stillZero = runtime(world, { do: "require", field: "level", bag: "physical", eq: "0" });
  assert.equal(stillZero.ok, false);
});

test("pin-machines: add may create a register; guards still refuse to treat missing as zero", () => {
  const world = worldWith();
  const added = runtime(world, { do: "add", field: "charge", by: "1" });
  assert.equal(added.ok, true);
  assert.equal(world.things[0].fields.charge, 1);
  const next = runtime(world, { do: "add", field: "charge", by: "2" });
  assert.equal(next.ok, true);
  assert.equal(world.things[0].fields.charge, 3);
});

test("pin-machines: when skips the rest; require rolls the decision to the caller", () => {
  const world = worldWith({ charge: 2, open: 0 });
  const gated = runtime(world, { do: "when", field: "charge", gte: "3" });
  assert.equal(gated.ok, true);
  assert.equal(gated.skipRest, true);
  const required = runtime(world, { do: "require", field: "open", eq: "1" });
  assert.equal(required.ok, false);
  assert.equal(required.cause.error_class, "guard_failed");
  const opened = runtime(world, { do: "set", field: "open", to: "1" });
  assert.equal(opened.ok, true);
  assert.equal(world.things[0].fields.open, 1);
  const pass = runtime(world, { do: "require", field: "open", eq: "1" });
  assert.equal(pass.ok, true);
  assert.equal(pass.skipRest, false);
});

test("pin-machines: lists, bounds, and public projection stay mechanical", () => {
  const world = worldWith();
  assert.equal(runtime(world, { do: "push", field: "phrase", to: "left" }).ok, true);
  assert.equal(runtime(world, { do: "push", field: "phrase", to: "right" }).ok, true);
  assert.deepEqual(world.things[0].fields.phrase, ["left", "right"]);
  assert.equal(runtime(world, { do: "require", field: "phrase", len_gte: "2" }).ok, true);
  assert.equal(runtime(world, { do: "require", field: "phrase", len_gte: "3" }).ok, false);
  const shown = publicFields(world.things[0]);
  assert.deepEqual(shown.phrase, ["left", "right"]);
  assert.equal(runtime(world, { do: "clear", field: "phrase" }).ok, true);
  assert.equal(world.things[0].fields, undefined);
  assert.equal(publicFields(world.things[0]), undefined);

  const overflow = worldWith({ charge: MECHANISM_BOUNDS.int_max });
  const boom = runtime(overflow, { do: "add", field: "charge", by: "1" });
  assert.equal(boom.ok, false);
});

test("pin-machines: a field on another room is not a nearby sensor", () => {
  const world = worldWith({ open: 1 }, [
    { id: "away", name: "secret", body: "no", ownerHandle: "alice_probe", placeId: "elsewhere", fields: { open: 1 } },
  ]);
  const peek = runtime(world, { do: "require", field: "open", of: "away", eq: "1" });
  assert.equal(peek.ok, false);
  assert.equal(peek.cause.error_class, "guard_failed");
});

test("pin-machines: actuate is reserved and does not write fields or physical", () => {
  const world = worldWith({ open: 0 });
  const pin = normalizeMachineStep({ do: "actuate", field: "aperture", to: "1" });
  assert.equal(pin.ok, true);
  const ran = runtime(world, pin.instruction);
  assert.equal(ran.ok, false);
  assert.equal(ran.cause.error_class, "no_actuator");
  assert.equal(world.things[0].fields.open, 0);
});

test("pin-machines: module stays a declarative host", () => {
  const source = readFileSync(new URL("../client/pin-machines.mjs", import.meta.url), "utf8");
  assert.equal(/new\s+Function\s*\(|\beval\s*\(|node:vm|\bvm\.|child_process/.test(source), false);
  for (const op of ["set", "add", "clear", "push", "when", "require", "actuate"]) {
    assert.equal(MACHINE_OPS.has(op), true, op);
  }
});
