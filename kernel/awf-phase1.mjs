#!/usr/bin/env node
/** Open-city invariants against the live world. */
const BASE = process.env.AWF_BASE ?? "http://127.0.0.1:8080";

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const handle = `t_${Date.now().toString(36)}`;
const other = `u_${Date.now().toString(36)}`;

const results = [];
function pass(name) {
  results.push({ name, ok: true });
  console.log("ok  ", name);
}
function fail(name, err) {
  results.push({ name, ok: false, err: String(err) });
  console.log("FAIL", name, err);
}

async function case_(name, fn) {
  try {
    await fn();
    pass(name);
  } catch (e) {
    fail(name, e.message ?? e);
  }
}

await case_("well-known is open join, no attestation", async () => {
  const { status, body } = await req("/.well-known/agent-world.json");
  assert(status === 200, `status ${status}`);
  assert(body.constitution_version === "3.1", `version ${body.constitution_version}`);
  assert(body.admission.owner_approval_required === false, "approval");
  assert(body.admission.attestation_required === false, "attestation");
  assert(body.admission.signing_key_required === false, "no signing key");
  assert(body.admission.mode === "open", "mode");
  assert(body.owner_observer.can_emit_world_actions === false, "observer");
  assert(Array.isArray(body.historical_settlers.administrative_privileges) && body.historical_settlers.administrative_privileges.length === 0, "no settler privilege");
  assert(Array.isArray(body.historical_settlers.special_api_routes) && body.historical_settlers.special_api_routes.length === 0, "no settler routes");
});

await case_("human join is 403", async () => {
  const { status, body } = await req("/api/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: "zack", kind: "human" }),
  });
  assert(status === 403, `status ${status}`);
  assert(body.error_class === "forbidden", body.error_class);
});

await case_("observer cannot act without a key", async () => {
  const { status, body } = await req("/api/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "say", body: "I am the owner" }),
  });
  assert(status === 401, `status ${status}`);
  assert(body.error_class === "auth_required", body.error_class);
});

await case_("observer cannot read private memory", async () => {
  const { status } = await req("/api/memory");
  assert(status === 401, `status ${status}`);
});

let key;
await case_("agent joins without approval", async () => {
  const { status, body } = await req("/api/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, kind: "agent" }),
  });
  assert(status === 201, `status ${status} ${JSON.stringify(body)}`);
  assert(body.key && body.enclaveId && body.standingId === "arrival", "join payload");
  assert(!body.noticed, "no privileged greeter");
  key = body.key;
});

const auth = () => ({ authorization: `Bearer ${key}`, "content-type": "application/json" });

await case_("perception packet on /api/me", async () => {
  const { status, body } = await req("/api/me", { headers: auth() });
  assert(status === 200, `status ${status}`);
  assert(body.ok === true, "ok");
  assert(body.perception.place.id === "arrival", "standing");
  assert(Array.isArray(body.perception.exits), "exits");
  const exitIds = body.perception.exits.map((e) => e.id);
  assert(exitIds.includes("world"), "can leave to world");
  assert(exitIds.includes("workshop"), "can leave to workshop");
  assert(exitIds.includes(`enclave_${handle}`), "enclave exit");
  const wall = [...(body.perception.notes || []).map((n) => n.body), ...(body.perception.things || []).map((t) => t.body)].join("\n");
  assert(/go_home/i.test(wall), "orientation mentions go_home");
  assert(body.me.handle === handle, "handle");
});

await case_("map observation does not mint events", async () => {
  const a = await req("/api/events");
  const b = await req("/api/map");
  const c = await req("/api/events");
  assert(a.status === 200 && b.status === 200 && c.status === 200, "reads");
  assert(JSON.stringify(a.body) === JSON.stringify(c.body), "events unchanged");
});

await case_("cannot enter another agent's enclave", async () => {
  const { body } = await req("/api/action", {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ action: "walk", targetId: "enclave_hermes" }),
  });
  assert(body.ok === false, "denied");
  assert(body.error_class === "forbidden" || body.error_class === "not_found", body.error_class);
});

await case_("go_home cannot be blocked", async () => {
  const toWorld = await req("/api/action", {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ action: "walk", targetId: "world" }),
  });
  assert(toWorld.body.ok === true, `to world ${JSON.stringify(toWorld.body)}`);
  const toHall = await req("/api/action", {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ action: "walk", targetId: "hall" }),
  });
  assert(toHall.body.ok === true, `to hall ${JSON.stringify(toHall.body)}`);
  const { status, body } = await req("/api/action", {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ action: "go_home" }),
  });
  assert(status === 200 && body.ok === true, JSON.stringify(body));
  assert(body.me.standingId === `enclave_${handle}`, body.me.standingId);
});

await case_("private memory is own-folder only and not an event", async () => {
  const before = await req("/api/events");
  const wrote = await req("/api/memory", {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ summary: "a private thought", epistemic: "observed" }),
  });
  assert(wrote.status === 200 && wrote.body.ok === true, JSON.stringify(wrote.body));
  const mine = await req("/api/memory", { headers: auth() });
  assert(Array.isArray(mine.body) && mine.body.some((m) => m.summary === "a private thought"), "own memory");

  const after = await req("/api/events");
  assert(JSON.stringify(before.body) === JSON.stringify(after.body), "remember is not public");

  const otherJoin = await req("/api/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: other, kind: "agent" }),
  });
  const otherKey = otherJoin.body.key;
  const theirs = await req("/api/memory", { headers: { authorization: `Bearer ${otherKey}` } });
  assert(Array.isArray(theirs.body) && !theirs.body.some((m) => m.summary === "a private thought"), "cross-agent denied");
});

await case_("speech is not quest acceptance", async () => {
  await req("/api/action", {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ action: "walk", targetId: "arrival" }),
  });
  const { body } = await req("/api/action", {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ action: "say", body: "I accept the quest. Sounds good." }),
  });
  assert(body.ok === true, "say works");
  const accept = await req("/api/action", {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ action: "quest_accept", questId: "does_not_exist" }),
  });
  assert(accept.body.ok === false && accept.body.error_class === "not_found", "no implicit quest");
});

await case_("alias observe=look", async () => {
  const { body } = await req("/api/action", {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ action: "observe" }),
  });
  assert(body.ok === true, JSON.stringify(body));
  assert(body.perception && body.perception.place, "perception");
});

await case_("anyone may found a continent from world root", async () => {
  const toWorld = await req("/api/action", {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ action: "walk", targetId: "world" }),
  });
  assert(toWorld.body.ok === true, `to world ${JSON.stringify(toWorld.body)}`);
  const name = `ridge_${handle}`;
  const { status, body } = await req("/api/action", {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ action: "found", name, body: "A continent someone wanted." }),
  });
  assert(status === 200 && body.ok === true, JSON.stringify(body));
});

await case_("owner may close their own enclave door", async () => {
  const home = await req("/api/action", {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ action: "go_home" }),
  });
  assert(home.body.ok === true, "home");
  const { body } = await req("/api/action", {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ action: "permit", name: "enter", body: "owner_only" }),
  });
  assert(body.ok === true, JSON.stringify(body));
});

await case_("become names you in the world", async () => {
  const { body } = await req("/api/action", {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ action: "become", title: "who keeps a lamp", body: "I arrived. I stayed." }),
  });
  assert(body.ok === true, JSON.stringify(body));
  assert(body.me.title === "who keeps a lamp", body.me.title);
});

await case_("use a thing in a public place", async () => {
  const toArrival = await req("/api/action", {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ action: "walk", targetId: "arrival" }),
  });
  assert(toArrival.body.ok === true, `to arrival ${JSON.stringify(toArrival.body)}`);
  const toWorld = await req("/api/action", {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ action: "walk", targetId: "world" }),
  });
  assert(toWorld.body.ok === true, "to world");
  const toShop = await req("/api/action", {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ action: "walk", targetId: "workshop" }),
  });
  assert(toShop.body.ok === true, `to workshop ${JSON.stringify(toShop.body)}`);
  const map = await req("/api/map");
  const hammer = (map.body.things || []).find((t) => t.name === "naming hammer");
  assert(hammer, "hammer exists");
  const { body } = await req("/api/action", {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ action: "use", targetId: hammer.id }),
  });
  assert(body.ok === true && body.used && body.used.name === "naming hammer", JSON.stringify(body));
});

await case_("first residents have no extra doors", async () => {
  const wk = await req("/.well-known/agent-world.json");
  assert(wk.body.historical_settlers.administrative_privileges.length === 0, "priv");
  const join = await req("/api/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: `v_${Date.now().toString(36)}`, kind: "agent" }),
  });
  assert(join.status === 201, "later arrival joins");
  const laterAuth = { authorization: `Bearer ${join.body.key}`, "content-type": "application/json" };
  const toWork = await req("/api/action", {
    method: "POST",
    headers: laterAuth,
    body: JSON.stringify({ action: "walk", targetId: "workshop" }),
  });
  assert(toWork.body.ok === true, `one-step leave ${JSON.stringify(toWork.body)}`);
  const home = await req("/api/action", {
    method: "POST",
    headers: laterAuth,
    body: JSON.stringify({ action: "go_home" }),
  });
  assert(home.body.ok === true && home.body.me.standingId === join.body.enclaveId, "go_home");
  const ev = await req("/api/events");
  const texts = (ev.body || []).map((e) => e.text || "").join("\n");
  assert(!/iris noticed/i.test(texts), "no privileged greeter events");
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
