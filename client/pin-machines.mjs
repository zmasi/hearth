// Bounded declarative mechanism layer for Hearth pins.
// Public `fields` on things/places. Physical sensors are a separate bag the
// physics owner wires; missing/unwired sensors never become a useful zero.
// No eval, vm, host I/O, or private memory.

export const MACHINE_OPS = new Set(["set", "add", "clear", "push", "when", "require", "actuate"]);
export const WRITE_OPS = new Set(["set", "add", "clear", "push"]);
export const GUARD_OPS = new Set(["when", "require"]);
export const COMPARATORS = ["eq", "ne", "lt", "gte", "exists", "len_gte"];
export const MACHINE_KEYS = new Set(["do", "field", "of", "bag", "to", "by", "eq", "ne", "lt", "gte", "exists", "len_gte", "want"]);
export const HOST_FORBIDDEN = new Set(["actorHandle", "handle", "key", "keyHash", "asHandle", "bearer", "module", "code", "process", "env", "path", "command"]);
export const FIELD_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const MECHANISM_BOUNDS = {
  max_fields: 32,
  max_string_bytes: 256,
  max_list_items: 32,
  max_bag_bytes: 4096,
  int_min: -1_000_000_000,
  int_max: 1_000_000_000,
};
const INT_RE = /^-?(0|[1-9][0-9]*)$/;

function fail(error_class, message, http_status, extra) {
  return extra ? { ok: false, error_class, message, http_status, ...extra } : { ok: false, error_class, message, http_status };
}

function guardFail(message, extra = {}) {
  return fail("script_failure", message, 409, { cause: { error_class: "guard_failed", message, http_status: 409, ...extra } });
}

export function subst(value, env) {
  if (typeof value !== "string") return value;
  return value.replace(/\$([a-z][a-z0-9_]{0,31})/g, (match, name) => Object.hasOwn(env, name) ? String(env[name]) : match);
}

function asInt(raw) {
  if (typeof raw === "number" && Number.isSafeInteger(raw)) return raw;
  if (typeof raw !== "string" || !INT_RE.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

function coerceScalar(raw, hint) {
  if (hint === "string") return { ok: true, value: String(raw) };
  if (hint === "bool") {
    if (raw === "true" || raw === true) return { ok: true, value: true };
    if (raw === "false" || raw === false) return { ok: true, value: false };
    return fail("script_failure", "Boolean fields accept true or false.", 400);
  }
  if (hint === "int") {
    const n = asInt(raw);
    if (n === null) return fail("script_failure", "Integer fields need a whole number.", 400);
    return { ok: true, value: n };
  }
  if (raw === true || raw === false) return { ok: true, value: raw };
  if (typeof raw === "number" && Number.isSafeInteger(raw)) return { ok: true, value: raw };
  if (raw === "true") return { ok: true, value: true };
  if (raw === "false") return { ok: true, value: false };
  const n = asInt(raw);
  if (n !== null) return { ok: true, value: n };
  return { ok: true, value: String(raw) };
}

function inIntRange(n) {
  return Number.isSafeInteger(n) && n >= MECHANISM_BOUNDS.int_min && n <= MECHANISM_BOUNDS.int_max;
}

function valueOk(value) {
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return inIntRange(value);
  if (typeof value === "string") return Buffer.byteLength(value, "utf8") <= MECHANISM_BOUNDS.max_string_bytes;
  if (Array.isArray(value)) {
    if (value.length > MECHANISM_BOUNDS.max_list_items) return false;
    return value.every(item => (typeof item === "boolean" || typeof item === "string" || typeof item === "number") && valueOk(item) && !Array.isArray(item));
  }
  return false;
}

export function publicFields(record) {
  if (!record || !record.fields || typeof record.fields !== "object" || Array.isArray(record.fields)) return undefined;
  const keys = Object.keys(record.fields);
  if (keys.length === 0) return undefined;
  const out = {};
  for (const key of keys) out[key] = structuredClone(record.fields[key]);
  return out;
}

export function projectRecord(record) {
  if (!record) return record;
  const fields = publicFields(record);
  if (!fields) {
    if (!record.fields) return record;
    const { fields: _omit, ...rest } = record;
    return rest;
  }
  return { ...record, fields };
}

export function normalizeMachineStep(step) {
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    return fail("bad_input", "Each instruction must be a JSON object.", 400);
  }
  const keys = Object.keys(step);
  for (const key of keys) {
    if (HOST_FORBIDDEN.has(key) || !MACHINE_KEYS.has(key)) {
      return fail("bad_input", "Instructions may only name existing world action fields.", 400);
    }
    if (key !== "do" && typeof step[key] !== "string") {
      return fail("bad_input", "Instruction fields must be strings.", 400);
    }
  }
  const op = String(step.do ?? "");
  if (!MACHINE_OPS.has(op)) return fail("bad_input", "Instructions may only compose existing world actions.", 400);
  const field = String(step.field ?? "").trim();
  if (!FIELD_NAME_RE.test(field)) return fail("bad_input", "Mechanism field names are [a-z][a-z0-9_]{0,31}.", 400);
  const bag = step.bag ?? "fields";
  if (bag !== "fields" && bag !== "physical") return fail("bad_input", "bag must be fields or physical.", 400);
  if (WRITE_OPS.has(op) && bag === "physical") {
    return fail("bad_input", "Programs cannot write physical sensors.", 400);
  }
  if (op === "set" && step.to == null) return fail("bad_input", "set needs to.", 400);
  if (op === "add" && step.by == null) return fail("bad_input", "add needs by.", 400);
  if (op === "push" && step.to == null) return fail("bad_input", "push needs to.", 400);
  if (op === "actuate" && step.to == null) return fail("bad_input", "actuate needs to.", 400);
  if (GUARD_OPS.has(op)) {
    const comps = COMPARATORS.filter(name => step[name] != null);
    if (comps.length !== 1) return fail("bad_input", "A guard names exactly one comparison.", 400);
    if (step.exists != null && step.exists !== "true" && step.exists !== "false") {
      return fail("bad_input", "exists is true or false.", 400);
    }
  }
  if (step.want && !["int", "string", "bool"].includes(step.want)) {
    return fail("bad_input", "want is int, string, or bool.", 400);
  }
  const instruction = { do: op, field };
  for (const key of MACHINE_KEYS) {
    if (key === "do" || key === "field" || step[key] == null) continue;
    instruction[key] = step[key];
  }
  return { ok: true, instruction };
}

function resolveId(instruction, env, pinTargetId) {
  if (!instruction.of) return pinTargetId;
  return subst(instruction.of, env);
}

export function locateHere(world, standingId, id) {
  if (!id || !standingId) return null;
  const thing = (world.things || []).find(item => item.id === id && !item.destroyedAt);
  if (thing) return thing.placeId === standingId ? { kind: "thing", record: thing } : null;
  const place = (world.places || []).find(item => item.id === id && !item.destroyedAt);
  if (place) return place.id === standingId ? { kind: "place", record: place } : null;
  return null;
}

function readBag({ world, standingId, instruction, env, pinTargetId, now, readPhysical }) {
  const bag = subst(instruction.bag || "fields", env);
  if (bag !== "fields" && bag !== "physical") return guardFail("bag must be fields or physical.");
  const id = resolveId(instruction, env, pinTargetId);
  const located = locateHere(world, standingId, id);
  if (!located) return guardFail("No such field target here.", { missing: true });
  const field = instruction.field;
  if (bag === "physical") {
    if (typeof readPhysical !== "function") {
      return guardFail("Physical sensor is not wired.", { missing: true, bag });
    }
    const reading = readPhysical({ world, target: located, field, now, standingId });
    if (!reading || reading.ok !== true) {
      return guardFail(reading?.message || "Physical sensor is unavailable.", { missing: true, bag });
    }
    if (reading.value === undefined) return guardFail("Physical sensor is unavailable.", { missing: true, bag });
    return { ok: true, value: reading.value, located, bag, field };
  }
  const fields = located.record.fields;
  if (!fields || !Object.hasOwn(fields, field)) {
    return guardFail("Mechanism field is missing.", { missing: true, bag: "fields" });
  }
  return { ok: true, value: fields[field], located, bag, field };
}

function lengthOf(value) {
  if (Array.isArray(value) || typeof value === "string") return value.length;
  return null;
}

function compare(value, instruction, env) {
  if (instruction.exists != null) {
    const want = instruction.exists === "true";
    const present = value !== undefined;
    return { ok: true, match: present === want };
  }
  if (instruction.len_gte != null) {
    const min = asInt(subst(instruction.len_gte, env));
    const len = lengthOf(value);
    if (min === null) return fail("script_failure", "len_gte needs a whole number.", 400);
    if (len === null) return { ok: true, match: false };
    return { ok: true, match: len >= min };
  }
  const rhsRaw = subst(instruction.eq ?? instruction.ne ?? instruction.lt ?? instruction.gte, env);
  const coerced = coerceScalar(rhsRaw, instruction.want);
  const rhs = coerced.ok === true ? coerced.value : rhsRaw;
  if (instruction.eq != null) return { ok: true, match: Object.is(value, rhs) || value === rhs };
  if (instruction.ne != null) return { ok: true, match: !(Object.is(value, rhs) || value === rhs) };
  if (typeof value !== "number" || typeof rhs !== "number") return { ok: true, match: false };
  if (instruction.lt != null) return { ok: true, match: value < rhs };
  if (instruction.gte != null) return { ok: true, match: value >= rhs };
  return fail("script_failure", "A guard names exactly one comparison.", 400);
}

function assignField(record, name, value) {
  if (!valueOk(value)) return fail("script_failure", "Mechanism field value exceeds bounds.", 400);
  const next = { ...(record.fields || {}) };
  if (!Object.hasOwn(next, name) && Object.keys(next).length >= MECHANISM_BOUNDS.max_fields) {
    return fail("script_failure", "This target already holds the maximum mechanism fields.", 429);
  }
  next[name] = value;
  if (Buffer.byteLength(JSON.stringify(next), "utf8") > MECHANISM_BOUNDS.max_bag_bytes) {
    return fail("script_failure", "Mechanism fields exceed the bag byte limit.", 400);
  }
  record.fields = next;
  return { ok: true, value };
}

function deleteField(record, name) {
  if (!record.fields || !Object.hasOwn(record.fields, name)) {
    if (record.fields && Object.keys(record.fields).length === 0) delete record.fields;
    return { ok: true, value: undefined };
  }
  const next = { ...record.fields };
  delete next[name];
  if (Object.keys(next).length === 0) delete record.fields;
  else record.fields = next;
  return { ok: true, value: undefined };
}

export function runMachineStep(ctx) {
  const { instruction, env, world, standingId, pinTargetId } = ctx;
  const op = instruction.do;
  if (op === "actuate") {
    return fail("script_failure", "No physical actuator is wired.", 409, { cause: { error_class: "no_actuator", message: "No physical actuator is wired.", http_status: 409 } });
  }
  if (GUARD_OPS.has(op)) {
    if (instruction.exists != null) {
      const bag = subst(instruction.bag || "fields", env);
      const id = resolveId(instruction, env, pinTargetId);
      const located = locateHere(world, standingId, id);
      if (!located) {
        if (op === "when") return { ok: true, skipRest: instruction.exists === "true", step: { do: op, skipped: true } };
        return guardFail("No such field target here.", { missing: true });
      }
      if (bag === "physical") {
        const read = readBag(ctx);
        const present = read.ok === true;
        const want = instruction.exists === "true";
        if (present !== want) {
          if (op === "when") return { ok: true, skipRest: true, step: { do: op, skipped: true } };
          return guardFail("Physical sensor existence did not match.", { missing: !present });
        }
        return { ok: true, skipRest: false, step: { do: op, matched: true } };
      }
      const present = Boolean(located.record.fields && Object.hasOwn(located.record.fields, instruction.field));
      const want = instruction.exists === "true";
      if (present !== want) {
        if (op === "when") return { ok: true, skipRest: true, step: { do: op, skipped: true } };
        return guardFail("Mechanism field existence did not match.", { missing: !present });
      }
      return { ok: true, skipRest: false, step: { do: op, matched: true } };
    }
    const read = readBag(ctx);
    if (!read.ok) {
      if (op === "when") return { ok: true, skipRest: true, step: { do: op, skipped: true, reason: read.message } };
      return read;
    }
    const verdict = compare(read.value, instruction, env);
    if (!verdict.ok) return verdict;
    if (!verdict.match) {
      if (op === "when") return { ok: true, skipRest: true, step: { do: op, skipped: true } };
      return guardFail("Mechanism guard was not met.");
    }
    return { ok: true, skipRest: false, step: { do: op, matched: true, field: instruction.field } };
  }

  const bag = subst(instruction.bag || "fields", env);
  if (bag === "physical") return fail("script_failure", "Programs cannot write physical sensors.", 403);
  const id = resolveId(instruction, env, pinTargetId);
  const located = locateHere(world, standingId, id);
  if (!located) return guardFail("No such field target here.", { missing: true });
  const field = instruction.field;
  if (op === "clear") {
    const cleared = deleteField(located.record, field);
    return { ok: true, skipRest: false, step: { do: "clear", field, of: located.record.id } };
  }
  if (op === "add") {
    const delta = asInt(subst(instruction.by, env));
    if (delta === null) return fail("script_failure", "add needs a whole number.", 400);
    const current = located.record.fields && Object.hasOwn(located.record.fields, field) ? located.record.fields[field] : 0;
    if (typeof current !== "number") return fail("script_failure", "add only applies to integer fields.", 400);
    const next = current + delta;
    if (!inIntRange(next)) return fail("script_failure", "Mechanism integer overflow.", 400);
    const written = assignField(located.record, field, next);
    if (!written.ok) return written;
    return { ok: true, skipRest: false, step: { do: "add", field, of: located.record.id, value: next } };
  }
  if (op === "push") {
    const item = coerceScalar(subst(instruction.to, env), instruction.want);
    if (!item.ok) return item;
    const current = located.record.fields && Object.hasOwn(located.record.fields, field) ? located.record.fields[field] : [];
    if (!Array.isArray(current)) return fail("script_failure", "push only applies to list fields.", 400);
    const next = current.concat([item.value]);
    const written = assignField(located.record, field, next);
    if (!written.ok) return written;
    return { ok: true, skipRest: false, step: { do: "push", field, of: located.record.id, value: next } };
  }
  if (op === "set") {
    const item = coerceScalar(subst(instruction.to, env), instruction.want);
    if (!item.ok) return item;
    const written = assignField(located.record, field, item.value);
    if (!written.ok) return written;
    return { ok: true, skipRest: false, step: { do: "set", field, of: located.record.id, value: item.value } };
  }
  return fail("script_failure", "Unknown machine op.", 400);
}

export function applyAdjust({ world, standingId, targetKind, targetId, field, op, to, by, as }) {
  if (!["thing", "place"].includes(targetKind) || typeof targetId !== "string" || !targetId) {
    return fail("bad_input", "adjust needs targetKind (thing or place), targetId, field, and op.", 400);
  }
  if (!FIELD_NAME_RE.test(field || "")) return fail("bad_input", "Mechanism field names are [a-z][a-z0-9_]{0,31}.", 400);
  if (!WRITE_OPS.has(op)) return fail("bad_input", "adjust op is set, add, clear, or push.", 400);
  const instruction = { do: op, field };
  if (to != null) instruction.to = String(to);
  if (by != null) instruction.by = String(by);
  if (as != null) instruction.want = String(as);
  const normalized = normalizeMachineStep(instruction);
  if (!normalized.ok) return normalized;
  return runMachineStep({
    instruction: normalized.instruction,
    env: { caller: "", place: standingId, target: targetId, verb: "adjust" },
    world,
    standingId,
    pinTargetId: targetId,
    now: null,
    readPhysical: null,
  });
}
