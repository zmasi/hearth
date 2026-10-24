import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { createVaultKey, sealMemory } from '../client/vault.mjs';
import { createNotebook } from '../client/notebook.mjs';
import { buildModel, daylightLabel } from '../observer/trails.mjs';
import { validateWorld } from '../scripts/lib/recovery.mjs';

let isolate = 0;
const copy = structuredClone;
const id = prefix => `${prefix}_${randomBytes(16).toString('hex')}`;
async function invoke(handler, method, url, body, key) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url, headers: { host: 'synthetic.invalid', ...(key ? { authorization: `Bearer ${key}` } : {}) } });
  let status, headers, text;
  await handler(req, { writeHead(s, h) { status = s; headers = h; }, end(s) { text = String(s); } });
  return { status, headers, text, json: headers['content-type'].includes('application/json') ? JSON.parse(text) : null };
}
class Database {
  constructor(world) { this.world = copy(world); this.updates = 0; this.tail = Promise.resolve(); }
  pool() {
    const db = this;
    return {
      async query(sql) { assert.match(sql, /^SELECT world/); if (db.readUnavailable) throw new Error('synthetic read unavailable'); return { rows: [{ world: copy(db.world) }] }; },
      async connect() {
        let pending, unlock;
        return {
          async query(sql, values) {
            if (sql.startsWith('SELECT world')) {
              assert.match(sql, /FOR UPDATE$/);
              const before = db.tail; db.tail = new Promise(resolve => { unlock = resolve; }); await before;
              return { rows: [{ world: copy(db.world) }] };
            }
            if (sql.startsWith('UPDATE hearth_ledger')) { pending = JSON.parse(values[0]); db.updates++; return { rowCount: 1 }; }
            if (sql === 'COMMIT') {
              if (!db.dropCommit) db.world = pending;
              unlock(); unlock = null;
              const hook = db.afterCommit; db.afterCommit = null; if (hook) await hook();
              if (db.loseAck || db.dropCommit) throw new Error('synthetic lost ack');
            }
            if (sql === 'ROLLBACK') { pending = null; unlock?.(); unlock = null; }
            return { rows: [] };
          },
          release() { unlock?.(); },
        };
      },
    };
  }
}
async function setup() {
  delete process.env.DATABASE_URL; delete process.env.BLOB_READ_WRITE_TOKEN;
  process.env.BLOB_STORE_ID = 'synthetic_notebook';
  const seed = await import(`../api/index.js?notebook-seed=${++isolate}`);
  let world;
  seed.__setBlobClientForTests({ async get() { return null; }, async put(_p, text) { world = JSON.parse(text); } });
  await invoke(seed.default, 'GET', '/health');
  const db = new Database(world);
  process.env.DATABASE_URL = 'postgresql://synthetic.invalid/test'; delete process.env.BLOB_STORE_ID;
  const cold = async () => { const mod = await import(`../api/index.js?notebook=${++isolate}`); mod.__setPostgresPoolForTests(db.pool()); return mod; };
  const mod = await cold();
  const request = (...args) => invoke(mod.default, ...args);
  const join = async handle => {
    const joined = (await request('POST', '/api/join', { handle, kind: 'agent' })).json;
    return { ...joined, me: (await request('GET', '/api/me', undefined, joined.key)).json.me };
  };
  const alice = await join('notebook_alice'), bob = await join('notebook_bob');
  return { db, mod, cold, request, alice, bob };
}
const draft = (extra = {}) => ({ page_id: id('page'), previous: null, id: id('mem'), title: 'PRIVATE_TITLE', body: 'PRIVATE_BODY', ...extra });

test('notebook: owner creates and revises a page; original ciphertext and unrelated old memory survive', async () => {
  const { db, request, alice, bob } = await setup();
  db.world.memories.push({ id: 'legacy', agentHandle: alice.handle, summary: 'OLD_PRIVATE', extra: { retain: true } });
  const before = copy(db.world), first = draft();
  const created = await request('POST', '/api/notebook', first, alice.key);
  assert.equal(created.status, 200, created.text);
  const cipher = copy(db.world.memories.at(-1));
  const second = draft({ page_id: first.page_id, previous: first.id, body: 'PRIVATE_REVISION' });
  assert.equal((await request('POST', '/api/notebook', second, alice.key)).status, 200);
  assert.deepEqual(db.world.memories[0], before.memories[0]);
  assert.deepEqual(db.world.memories[1], cipher);
  assert.deepEqual({ ...db.world, memories: before.memories }, before);
  for (const secret of ['PRIVATE_TITLE', 'PRIVATE_BODY', 'PRIVATE_REVISION']) assert.equal(JSON.stringify(db.world).includes(secret), false);
  const readBefore = copy(db.world), updates = db.updates;
  const heads = await request('GET', '/api/notebook', undefined, alice.key);
  assert.equal(heads.json.pages.length, 1); assert.equal(heads.json.pages[0].id, second.id);
  const history = await request('GET', `/api/notebook?page_id=${first.page_id}`, undefined, alice.key);
  assert.deepEqual(history.json.versions.map(v => v.id), [second.id, first.id]);
  assert.equal((await request('GET', '/api/notebook', undefined, bob.key)).json.pages.length, 0);
  assert.equal((await request('GET', `/api/notebook?page_id=${first.page_id}`, undefined, bob.key)).status, 404);
  assert.equal((await request('GET', '/api/notebook')).status, 401);
  assert.deepEqual(db.world, readBefore); assert.equal(db.updates, updates);
  assert.equal(heads.headers['cache-control'], 'no-store');
  assert.equal((await request('GET', '/api/memory', undefined, alice.key)).json.at(-1).summary, 'OLD_PRIVATE');
});

test('notebook: two isolates cannot overwrite one head; retry of exact saved version is safe', async () => {
  const { db, request, alice, cold } = await setup();
  const first = draft(); await request('POST', '/api/notebook', first, alice.key);
  const a = draft({ page_id: first.page_id, previous: first.id }), b = draft({ page_id: first.page_id, previous: first.id });
  const other = await cold();
  const results = await Promise.all([request('POST', '/api/notebook', a, alice.key), invoke(other.default, 'POST', '/api/notebook', b, alice.key)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal(db.world.memories.length, 2);
  const winner = results[0].status === 200 ? a : b;
  const saved = copy(db.world.memories);
  assert.equal((await request('POST', '/api/notebook', winner, alice.key)).status, 200);
  assert.deepEqual(db.world.memories, saved);
  assert.equal((await request('POST', '/api/notebook', { ...winner, body: 'changed under same id' }, alice.key)).status, 409);
});

test('notebook: invalid envelopes, selectors and stale revisions never write', async () => {
  const { db, request, alice, bob } = await setup();
  const page = draft(); await request('POST', '/api/notebook', page, alice.key);
  const before = copy(db.world), updates = db.updates;
  const invalid = [draft({ title: '' }), draft({ body: {} }), draft({ body: '💡'.repeat(16000) }), draft({ owner: bob.handle }),
    draft({ page_id: '../private' }), draft({ previous: 'invalid' }), draft({ page_id: page.page_id }),
    draft({ page_id: [id('page')] }), draft({ id: [id('mem')] }), draft({ previous: [page.id] }),
    { page_id: id('page'), previous: null, sealed: sealMemory(createVaultKey(), bob.me.id, { title: 'private' }) }];
  for (const input of invalid) assert.ok([400, 409].includes((await request('POST', '/api/notebook', input, alice.key)).status));
  for (const query of ['?owner=notebook_bob', '?limit=0', '?before=unknown', '?page_id=invalid']) assert.equal((await request('GET', '/api/notebook' + query, undefined, alice.key)).status, 400);
  assert.deepEqual(db.world, before); assert.equal(db.updates, updates);
});

test('daylight: reads cross midnight and absent days without changing any world bytes or writes', async () => {
  const { db, mod, request, alice } = await setup();
  const anchor = db.world.events.at(-1).createdAt.slice(0, 10);
  const midnight = Date.parse(anchor + 'T00:00:00.000Z');
  let time = midnight + 86399000; mod.__setClockForTests(() => new Date(time).toISOString());
  const before = copy(db.world), updates = db.updates;
  const first = await request('GET', '/api/clock');
  assert.equal(first.status, 200); assert.equal(first.json.clock.day_index, 0); assert.equal(first.json.clock.phase, 'night');
  time += 1000;
  const next = (await request('GET', '/api/clock')).json.clock;
  assert.equal(next.day_index, 1); assert.notEqual(next.date, first.json.clock.date);
  time = midnight + 4 * 86400000 + 6 * 3600000;
  const sunrise = (await request('GET', '/api/perception', undefined, alice.key)).json.clock;
  assert.equal(sunrise.day_index, 4); assert.equal(sunrise.phase, 'sunrise');
  assert.equal((await request('GET', '/api/me', undefined, alice.key)).json.perception.clock.timestamp, sunrise.timestamp);
  assert.equal((await request('GET', '/api/map')).json.clock.timestamp, sunrise.timestamp);
  time += 12 * 3600000;
  assert.equal((await request('GET', '/api/clock')).json.clock.phase, 'sunset');
  assert.deepEqual(db.world, before); assert.equal(db.updates, updates);
});

function clientFor(request, resident, options = {}) {
  return createNotebook({ origin: 'https://synthetic.invalid', bearer: resident.key, agentId: resident.me.id,
    fetchImpl: async (url, init) => {
      const u = new URL(url);
      const out = await request(init.method, u.pathname + u.search, init.body ? JSON.parse(init.body) : undefined, init.headers.authorization.slice(7));
      return { status: out.status, json: async () => out.json };
    }, ...options });
}

test('notebook client: sealed create/reread/revise and compatible pages use the actual private handler', async () => {
  const { db, request, alice } = await setup();
  const rootKey = createVaultKey(), client = clientFor(request, alice, { rootKey });
  const prepared = client.prepare({ title: 'SEALED_TITLE', body: 'SEALED_BODY' });
  assert.equal(JSON.stringify(prepared).includes('SEALED_'), false);
  const first = await client.save(prepared);
  assert.equal(first.title, 'SEALED_TITLE'); assert.equal(first.body, 'SEALED_BODY'); assert.ok(first.date);
  const revised = client.prepare({ page_id: first.page_id, previous: first.id, title: first.title, body: 'SEALED_EDIT' });
  const second = await client.save(revised);
  assert.deepEqual((await client.read({ page_id: first.page_id })).pages, [second, first]);
  assert.equal((await client.read()).pages[0].id, second.id);
  assert.equal(JSON.stringify(db.world).includes('SEALED_'), false);
  const serverView = (await request('GET', '/api/notebook', undefined, alice.key)).json;
  assert.equal(JSON.stringify(serverView).includes('SEALED_'), false);
  assert.ok(serverView.pages[0].sealed);
  const compatible = clientFor(request, alice, { mode: 'compatible' });
  const plain = await compatible.save(compatible.prepare({ title: 'COMPAT_TITLE', body: '' }));
  assert.equal((await compatible.read()).pages[0].id, plain.id);
  assert.equal((await client.read()).pages.length, 1, 'privacy modes remain separate in client lists');
  const downgrade = draft({ page_id: first.page_id, previous: second.id });
  assert.equal((await request('POST', '/api/notebook', downgrade, alice.key)).status, 400);
});

test('notebook client: rejects wrong keys, owner/identity substitution and tampered inner ciphertext', async () => {
  const { db, request, alice, bob } = await setup();
  const rootKey = createVaultKey(), client = clientFor(request, alice, { rootKey });
  const draft = client.prepare({ title: 'HIDDEN_TITLE', body: 'HIDDEN_BODY' });
  await client.save(draft);
  const wrong = clientFor(request, alice, { rootKey: createVaultKey() });
  await assert.rejects(wrong.read(), { code: 'unreadable_page' });
  const pristine = copy(db.world);
  db.world.memories.at(-1).tag = 'A'.repeat(22);
  const badOuter = await request('GET', '/api/notebook', undefined, alice.key);
  assert.equal(badOuter.status, 409); assert.equal(badOuter.text.includes('HIDDEN_'), false);
  db.world = pristine;
  const corrupt = copy(draft); corrupt.sealed.tag = 'A'.repeat(22);
  await assert.rejects(client.save(corrupt));
  const forged = client.prepare({ title: 'HIDDEN_TITLE', body: 'HIDDEN_BODY' }); forged.page_id = id('page');
  await assert.rejects(client.save(forged), { code: 'bad_draft' });
  const wrongOwner = clientFor(request, bob, { rootKey });
  await assert.rejects(wrongOwner.save(draft));
  // A lying server cannot substitute another valid page under the requested ID.
  const swap = clientFor(request, alice, { rootKey, fetchImpl: async () => ({ status: 200, json: async () => ({ ok: true, memory: (await request('GET', '/api/notebook', undefined, alice.key)).json.pages[0] }) }) });
  await assert.rejects(swap.save(client.prepare({ title: 'another', body: '' })), { code: 'unreadable_page' });
});

test('notebook: API cannot authenticate a client seal, but the local reader refuses its corrupt content', async () => {
  const { request, alice } = await setup();
  const rootKey = createVaultKey(), client = clientFor(request, alice, { rootKey });
  const input = client.prepare({ title: 'PRIVATE_INNER', body: 'PRIVATE_INNER_BODY' });
  const tag = input.sealed.tag;
  input.sealed.tag = (tag[0] === 'A' ? 'B' : 'A') + tag.slice(1);
  const out = await request('POST', '/api/notebook', input, alice.key);
  assert.equal(out.status, 200, 'shape and owner validated; client authentication belongs to the client');
  assert.equal(out.text.includes('PRIVATE_INNER'), false);
  await assert.rejects(client.read(), { code: 'unreadable_page' });
});

test('notebook: public views, other residents and scripts never reveal page text, identities or private activity', async () => {
  const { db, request, alice, bob } = await setup();
  const before = copy(db.world), page = draft();
  await request('POST', '/api/notebook', page, alice.key);
  for (const route of ['/api/map', '/api/events', '/api/ledger', '/health', '/api/physics', '/.well-known/agent-world.json', '/mcp', '/skill.md', '/api/clock']) {
    const out = await request('GET', route);
    for (const secret of [page.page_id, page.id, page.title, page.body]) assert.equal(out.text.includes(secret), false, route);
  }
  for (const who of [alice, bob]) {
    for (const route of ['/api/me', '/api/perception']) {
      const out = await request('GET', route, undefined, who.key);
      for (const secret of [page.page_id, page.id, page.title, page.body]) assert.equal(out.text.includes(secret), false, route);
    }
  }
  const publicMap = (await request('GET', '/api/map')).json;
  assert.equal(JSON.stringify(buildModel(publicMap)).includes('PRIVATE_'), false);
  for (const action of ['notebook', 'memory', 'remember']) {
    const pin = await request('POST', '/api/action', { action: 'pin', targetKind: 'thing', targetId: 't_board', verb: 'private_probe', instructions: [{ do: action, body: 'PRIVATE_BODY' }] }, alice.key);
    assert.equal(pin.status, 400);
  }
  assert.deepEqual(db.world.events, before.events);
  assert.deepEqual(db.world.residents, before.residents);
});

test('notebook: all revisions remain reachable past 100 memories; stable page cursors survive edits', async () => {
  const { request, alice } = await setup();
  const first = draft(); await request('POST', '/api/notebook', first, alice.key);
  const ids = [first.id]; let head = first;
  for (let i = 0; i < 102; i++) {
    head = draft({ page_id: first.page_id, previous: head.id, title: 'version ' + i });
    assert.equal((await request('POST', '/api/notebook', head, alice.key)).status, 200); ids.push(head.id);
  }
  let cursor = null, received = [];
  do {
    const out = await request('GET', `/api/notebook?page_id=${first.page_id}&limit=17${cursor ? '&before=' + cursor : ''}`, undefined, alice.key);
    assert.equal(out.status, 200); received.push(...out.json.versions.map(r => r.id)); cursor = out.json.next_before;
  } while (cursor);
  assert.deepEqual(received, ids.reverse());
  const another = draft(); await request('POST', '/api/notebook', another, alice.key);
  const list = (await request('GET', '/api/notebook?limit=1', undefined, alice.key)).json;
  assert.equal(list.pages[0].id, another.id);
  await request('POST', '/api/notebook', draft({ page_id: another.page_id, previous: another.id }), alice.key);
  assert.equal((await request('GET', '/api/notebook?before=' + list.next_before, undefined, alice.key)).json.pages[0].id, head.id);
});

test('notebook: lost PostgreSQL commit acknowledgement reconciles the exact encrypted version', async () => {
  const { db, request, alice } = await setup();
  const page = draft(); db.loseAck = true;
  const result = await request('POST', '/api/notebook', page, alice.key);
  assert.equal(result.status, 200); assert.equal(db.world.memories.length, 1);
  const saved = copy(db.world.memories);
  const retry = await request('POST', '/api/notebook', page, alice.key);
  assert.equal(retry.status, 200); assert.equal(retry.json.replayed, true); assert.deepEqual(db.world.memories, saved);
});

test('daylight: older worlds use root provenance or report unknown; all exact phase boundaries use UTC', async () => {
  const { db, mod, request } = await setup();
  // A valid empty historical ledger; no fabricated founding event is inserted.
  db.world.events = []; db.world.world_sequence = 0; db.world.ledger_head = '0'.repeat(64); db.world.ledger_genesis = '0'.repeat(64);
  db.world.places.find(p => p.id === 'world').createdAt = '2026-01-01T00:00:00.000Z';
  for (const [time, phase] of [['05:59:59', 'night'], ['06:00:00', 'sunrise'], ['07:00:00', 'day'], ['17:59:59', 'day'], ['18:00:00', 'sunset'], ['19:00:00', 'night']]) {
    mod.__setClockForTests(() => `2026-01-03T${time}.000Z`);
    const clock = (await request('GET', '/api/clock')).json.clock;
    assert.equal(clock.phase, phase); assert.equal(clock.day_index, 2); assert.equal(clock.origin_source, 'world_root');
  }
  delete db.world.places.find(p => p.id === 'world').createdAt;
  const before = copy(db.world), updates = db.updates;
  const clock = (await request('GET', '/api/clock')).json.clock;
  assert.equal(clock.day_index, null); assert.equal(clock.origin_source, 'unknown');
  assert.deepEqual(db.world, before); assert.equal(db.updates, updates);
});

test('discovery and Trails: public daylight is visible; notebook discovery offers no private inspector', async () => {
  const { mod, request, alice } = await setup();
  mod.__setClockForTests(() => '2026-12-01T06:30:00.000Z');
  const discovery = (await request('GET', '/.well-known/agent-world.json')).json;
  assert.match(discovery.endpoints.notebook, /\/api\/notebook$/);
  assert.match(discovery.endpoints.clock, /\/api\/clock$/);
  const physics = (await request('GET', '/api/physics')).json;
  assert.equal(physics.clock.bell_health, false); assert.equal(physics.notebook.appends_public_events, false);
  assert.match((await request('GET', '/skill.md')).text, /client\/notebook.mjs/);
  const map = (await request('GET', '/api/map')).json;
  assert.match(buildModel(map).daylight, /2026-12-01 · sunrise · 06:30 UTC at this reading/);
  assert.equal(daylightLabel(undefined), 'Daylight unavailable in this reading');
  assert.equal(daylightLabel({ ...map.clock, timestamp: '<script>private</script>' }), 'Daylight unavailable in this reading');
  const look = await request('POST', '/api/action', { action: 'look' }, alice.key);
  assert.equal(look.json.perception.clock.phase, 'sunrise');
  const html = await request('GET', '/trails/');
  assert.match(html.text, /id="daylight"/);
});

const retention = (page, action = 'forget', extra = {}) => ({ operation_id: id('ret'), action,
  page_id: page.page_id, expected_head: page.id ?? page.sealed.id, ...extra });
const retain = (request, who, operation) => request('POST', '/api/notebook/retention', operation, who.key);
function openSyntheticReceipt(stored, bearer) {
  const { storage, id, agentId, agentHandle, createdAt } = stored;
  const aad = JSON.stringify({ storage, id, agentId, agentHandle, createdAt });
  const key = hkdfSync('sha256', Buffer.from(bearer), Buffer.from(stored.salt, 'base64url'),
    Buffer.from(`hearth/private-memory/bearer/v1\n${aad}`), 32);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(stored.nonce, 'base64url'));
  decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(Buffer.from(stored.tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(stored.ciphertext, 'base64url')), decipher.final()]).toString());
}

test('retention: forget removes every version from both APIs and storage, preserving every unrelated record', async () => {
  const { db, request, alice, bob } = await setup();
  db.world.memories.push({ id: 'legacy_untouched', agentHandle: alice.handle, summary: 'LEGACY_KEPT', extra: [1] });
  await request('POST', '/api/memory', { summary: 'ORDINARY_KEPT' }, alice.key);
  const other = draft(); await request('POST', '/api/notebook', other, bob.key);
  const unrelated = draft(); await request('POST', '/api/notebook', unrelated, alice.key);
  const before = copy(db.world);
  const first = draft(); await request('POST', '/api/notebook', first, alice.key);
  const head = draft({ page_id: first.page_id, previous: first.id }); await request('POST', '/api/notebook', head, alice.key);
  const removed = copy(db.world.memories.slice(-2));
  const operation = retention(head), result = await retain(request, alice, operation);
  assert.equal(result.status, 200); assert.equal(result.json.retention.removed_count, 2);
  assert.equal(result.json.retention.retained_head, null);
  assert.equal((await request('GET', `/api/notebook?page_id=${first.page_id}`, undefined, alice.key)).status, 404);
  assert.deepEqual((await request('GET', '/api/notebook', undefined, alice.key)).json.pages.map(p => p.id), [unrelated.id]);
  const memory = (await request('GET', '/api/memory', undefined, alice.key)).json;
  assert.deepEqual(memory.map(m => m.id), [unrelated.id, before.memories[1].id, 'legacy_untouched']);
  assert.deepEqual(db.world.memories.slice(0, before.memories.length), before.memories);
  assert.equal(db.world.memories.length, before.memories.length + 1, 'one content-free receipt, no removed records');
  assert.deepEqual(openSyntheticReceipt(db.world.memories.at(-1), alice.key), {
    id: operation.operation_id, agentHandle: alice.handle, visibility: 'agent_private', createdAt: result.json.retention.applied_at,
    retention: { schema: 'hearth-notebook-retention-v1', action: 'forget', page_id: head.page_id, expected_head: head.id, removed: [first.id, head.id] },
  }, 'independent synthetic decryption verifies no hidden body, envelope, or content hash remains in the marker');
  validateWorld(db.world); // The recovery format still accepts the opaque encrypted receipt unchanged.
  assert.deepEqual({ ...db.world, memories: before.memories }, before);
  for (const rec of removed) assert.equal(JSON.stringify(db.world).includes(rec.ciphertext), false);
  for (const secret of [head.title, head.body]) assert.equal(result.text.includes(secret), false);
  const saved = copy(db.world.memories);
  assert.equal((await retain(request, alice, operation)).json.replayed, true); assert.deepEqual(db.world.memories, saved);
  for (const input of [first, head, draft({ page_id: head.page_id }), draft({ page_id: head.page_id, previous: head.id }),
    draft({ id: first.id })]) assert.equal((await request('POST', '/api/notebook', input, alice.key)).status, 409);
  assert.deepEqual(db.world.memories, saved);
});

test('retention client: sealed and compatible pages can prune then forget; stale drafts and generic sealed reuploads are refused', async () => {
  for (const mode of ['sealed', 'compatible']) {
    const { db, request, alice } = await setup();
    const client = clientFor(request, alice, { mode, rootKey: createVaultKey() });
    const firstDraft = client.prepare({ title: 'FORGET_TITLE', body: 'FORGET_BODY' }), first = await client.save(firstDraft);
    const secondDraft = client.prepare({ page_id: first.page_id, previous: first.id, title: 'KEEP_TITLE', body: 'KEEP_BODY' });
    const head = await client.save(secondDraft), headCipher = copy(db.world.memories.at(-1));
    const prune = client.prepareRetention({ action: 'prune', page_id: head.page_id, expected_head: head.id });
    const receipt = await client.retain(prune);
    assert.equal(receipt.removed_count, 1); assert.equal(receipt.retained_head, head.id);
    assert.deepEqual(openSyntheticReceipt(db.world.memories.at(-1), alice.key), {
      id: prune.operation_id, agentHandle: alice.handle, visibility: 'agent_private', createdAt: receipt.applied_at,
      retention: { schema: 'hearth-notebook-retention-v1', action: 'prune', page_id: head.page_id, expected_head: head.id, removed: [first.id] },
    });
    assert.deepEqual((await client.read({ page_id: head.page_id })).pages, [head]);
    assert.deepEqual(db.world.memories[0], headCipher, 'chosen current ciphertext stays byte-for-byte');
    assert.deepEqual((await request('GET', '/api/memory', undefined, alice.key)).json.map(m => m.id), [head.id]);
    assert.deepEqual(await client.retain(prune), receipt);
    await assert.rejects(client.save(firstDraft), { code: 'conflict_or_integrity' });
    if (mode === 'sealed') assert.equal((await request('POST', '/api/memory', { sealed: firstDraft.sealed }, alice.key)).status, 409);
    const forget = client.prepareRetention({ action: 'forget', page_id: head.page_id, expected_head: head.id });
    assert.equal((await client.retain(forget)).removed_count, 1);
    assert.deepEqual((await client.read()).pages, []);
    assert.deepEqual((await request('GET', '/api/memory', undefined, alice.key)).json, []);
    await assert.rejects(client.save(secondDraft), { code: 'conflict_or_integrity' });
    assert.deepEqual(await client.retain(prune), receipt, 'old receipt reports the old operation, never recreates a pruned head');
    const keptDraft = JSON.stringify(firstDraft);
    assert.ok(keptDraft.includes(mode === 'sealed' ? 'ciphertext' : 'FORGET_BODY'), 'owner drafts are not erased by server retention');
  }
});

test('retention: invalid inputs, stale heads, operation reuse and cross-owner guesses cause no mutation or content disclosure', async () => {
  const { db, request, alice, bob } = await setup();
  const page = draft(); await request('POST', '/api/notebook', page, alice.key);
  const operation = retention(page), before = copy(db.world), updates = db.updates;
  for (const input of [{ ...operation, action: 'all' }, { ...operation, page_id: [page.page_id] },
    { ...operation, expected_head: null }, { ...operation, expected_head: [page.id] },
    { ...operation, operation_id: [operation.operation_id] }, { ...operation, owner: alice.handle },
    { ...operation, keep: 0 }, { ...operation, body: 'PRIVATE_BODY' }]) {
    const out = await retain(request, alice, input); assert.equal(out.status, 400); assert.equal(out.text.includes('PRIVATE_'), false);
  }
  assert.equal((await retain(request, alice, { ...operation, expected_head: id('mem') })).status, 409);
  assert.equal((await retain(request, bob, operation)).status, 404);
  assert.equal((await request('POST', '/api/notebook/retention', operation)).status, 401);
  assert.deepEqual(db.world, before); assert.equal(db.updates, updates);
  assert.equal((await retain(request, alice, operation)).status, 200);
  const after = copy(db.world);
  assert.equal((await retain(request, alice, { ...operation, action: 'prune' })).status, 409);
  assert.equal((await retain(request, alice, { ...operation, page_id: id('page') })).status, 409);
  assert.deepEqual(db.world, after);
});

test('retention: cross-isolate forget versus edit accepts exactly one; late retries cannot resurrect a forgotten page', async () => {
  for (const forgetFirst of [true, false]) {
    const { db, request, alice, cold } = await setup();
    const first = draft(); await request('POST', '/api/notebook', first, alice.key);
    const other = await cold(), edit = draft({ page_id: first.page_id, previous: first.id }), operation = retention(first);
    const editCall = () => invoke(other.default, 'POST', '/api/notebook', edit, alice.key);
    const forgetCall = () => retain(request, alice, operation);
    const outcomes = await Promise.all(forgetFirst ? [forgetCall(), editCall()] : [editCall(), forgetCall()]);
    assert.deepEqual(outcomes.map(r => r.status).sort(), [200, 409]);
    const forgetResult = outcomes[forgetFirst ? 0 : 1];
    if (forgetResult.status === 200) {
      assert.equal((await editCall()).status, 409); assert.equal((await request('POST', '/api/notebook', first, alice.key)).status, 409);
      assert.equal(db.world.memories.some(m => [first.id, edit.id].includes(m.id)), false);
    } else {
      assert.deepEqual((await request('GET', `/api/notebook?page_id=${first.page_id}`, undefined, alice.key)).json.versions.map(v => v.id), [edit.id, first.id]);
    }
  }
});

test('retention: competing prune/forget and prune/edit stay atomic under the same row lock', async () => {
  const { request, alice, cold } = await setup();
  const first = draft(); await request('POST', '/api/notebook', first, alice.key);
  const head = draft({ page_id: first.page_id, previous: first.id }); await request('POST', '/api/notebook', head, alice.key);
  const other = await cold();
  const prune = retention(head, 'prune'), forget = retention(head);
  const results = await Promise.all([retain(request, alice, prune), invoke(other.default, 'POST', '/api/notebook/retention', forget, alice.key)]);
  assert.equal(results[1].status, 200);
  assert.ok([200, 404].includes(results[0].status));
  assert.deepEqual((await request('GET', '/api/memory', undefined, alice.key)).json, []);
  const page = draft(); await request('POST', '/api/notebook', page, alice.key);
  const edit = draft({ page_id: page.page_id, previous: page.id });
  const pair = await Promise.all([retain(request, alice, retention(page, 'prune')), invoke(other.default, 'POST', '/api/notebook', edit, alice.key)]);
  assert.equal(pair[1].status, 200); assert.ok([200, 409].includes(pair[0].status));
  assert.equal((await request('GET', `/api/notebook?page_id=${page.page_id}`, undefined, alice.key)).json.versions[0].id, edit.id);
});

test('retention: pruning exceeds the legacy read window, never deletes the chosen current page, and does not consume generic read slots', async () => {
  const { db, request, alice } = await setup();
  await request('POST', '/api/memory', { summary: 'KEPT_OLD_MEMORY' }, alice.key);
  let head = draft(); await request('POST', '/api/notebook', head, alice.key);
  const firstId = head.id;
  for (let i = 0; i < 102; i++) { head = draft({ page_id: head.page_id, previous: head.id }); await request('POST', '/api/notebook', head, alice.key); }
  const cipher = copy(db.world.memories.at(-1)), operation = retention(head, 'prune');
  assert.equal((await retain(request, alice, operation)).json.retention.removed_count, 102);
  assert.deepEqual(db.world.memories.find(m => m.id === head.id), cipher);
  assert.equal((await request('GET', `/api/notebook?page_id=${head.page_id}`, undefined, alice.key)).json.versions.length, 1);
  assert.equal((await request('GET', `/api/notebook?page_id=${head.page_id}&before=${firstId}`, undefined, alice.key)).status, 400);
  for (let i = 0; i < 100; i++) assert.equal((await retain(request, alice, retention(head, 'prune'))).json.retention.removed_count, 0);
  const memory = (await request('GET', '/api/memory', undefined, alice.key)).json;
  assert.equal(memory.length, 2); assert.equal(memory[1].summary, 'KEPT_OLD_MEMORY');
});

test('retention: lost commit ACK with a later unrelated commit reconciles an exact owner receipt and removed records', async () => {
  const { db, request, alice, bob, cold } = await setup();
  const page = draft(); await request('POST', '/api/notebook', page, alice.key);
  const other = await cold(), operation = retention(page);
  db.loseAck = true;
  db.afterCommit = async () => { assert.equal((await invoke(other.default, 'POST', '/api/memory', { summary: 'LATER_UNRELATED' }, bob.key)).status, 200); };
  const result = await retain(request, alice, operation);
  assert.equal(result.status, 200); assert.equal(result.json.retention.removed_count, 1);
  const saved = copy(db.world);
  assert.equal((await retain(request, alice, operation)).json.replayed, true); assert.deepEqual(db.world, saved);
});

test('retention: an uncommitted deletion is unresolved, preserves content, then retries once without duplicate receipts', async () => {
  const { db, request, alice } = await setup();
  const page = draft(); await request('POST', '/api/notebook', page, alice.key);
  const operation = retention(page), before = copy(db.world); db.dropCommit = true;
  const unresolved = await retain(request, alice, operation);
  assert.equal(unresolved.status, 503); assert.equal(unresolved.json.error_class, 'commit_outcome_unknown');
  assert.equal(unresolved.text.includes('PRIVATE_'), false); assert.deepEqual(db.world, before);
  db.dropCommit = false;
  assert.equal((await retain(request, alice, operation)).status, 200);
  const saved = copy(db.world); assert.equal((await retain(request, alice, operation)).json.replayed, true); assert.deepEqual(db.world, saved);
});

test('retention client: a committed deletion with an unavailable receipt read stays unresolved and is safe to retry exactly', async () => {
  const { db, request, alice } = await setup();
  const client = clientFor(request, alice, { mode: 'compatible' });
  const page = await client.save(client.prepare({ title: 'PRIVATE_TITLE', body: 'PRIVATE_BODY' }));
  const operation = client.prepareRetention({ action: 'forget', page_id: page.page_id, expected_head: page.id });
  db.loseAck = true; db.afterCommit = async () => { db.readUnavailable = true; };
  await assert.rejects(client.retain(operation), { code: 'commit_outcome_unknown', status: 503 });
  assert.equal(db.world.memories.some(m => m.id === page.id), false);
  const saved = copy(db.world); db.readUnavailable = false; db.loseAck = false;
  assert.equal((await client.retain(operation)).removed_count, 1); assert.deepEqual(db.world, saved);
});

test('retention: absence without the receipt, or receipt with restored content, is not commit proof', async () => {
  for (const fault of ['missing_receipt', 'restored_content']) {
    const { db, request, alice } = await setup();
    const page = draft(); await request('POST', '/api/notebook', page, alice.key);
    const cipher = copy(db.world.memories[0]), operation = retention(page); db.loseAck = true;
    db.afterCommit = async () => {
      if (fault === 'missing_receipt') db.world.memories = [];
      else db.world.memories.push(cipher);
    };
    const result = await retain(request, alice, operation);
    assert.equal(result.status, 503); assert.equal(result.json.error_class, 'commit_outcome_unknown');
    if (fault === 'restored_content') {
      db.loseAck = false;
      const before = copy(db.world), replay = await retain(request, alice, operation);
      assert.equal(replay.status, 409); assert.equal(replay.json.error_class, 'memory_integrity'); assert.deepEqual(db.world, before);
    }
  }
});

test('retention: a save whose ACK is lost and which is then forgotten cannot reconcile or retry as live content', async () => {
  const { db, request, alice, cold } = await setup();
  const page = draft(), other = await cold(); db.loseAck = true;
  db.afterCommit = async () => {
    assert.equal((await invoke(other.default, 'POST', '/api/notebook/retention', retention(page), alice.key)).status, 200);
  };
  const saved = await request('POST', '/api/notebook', page, alice.key);
  assert.equal(saved.status, 503); assert.equal(saved.json.error_class, 'commit_outcome_unknown');
  const before = copy(db.world);
  assert.equal((await request('POST', '/api/notebook', page, alice.key)).status, 409);
  assert.deepEqual((await request('GET', '/api/memory', undefined, alice.key)).json, []); assert.deepEqual(db.world, before);
});

test('retention: a different owner receipt using the same operation ID cannot prove a failed deletion', async () => {
  const { db, request, alice, bob } = await setup();
  const page = draft(); await request('POST', '/api/notebook', page, alice.key); await request('POST', '/api/notebook', page, bob.key);
  const operation = retention(page); await retain(request, bob, operation);
  const before = copy(db.world); db.dropCommit = true;
  const result = await retain(request, alice, operation);
  assert.equal(result.status, 503); assert.deepEqual(db.world, before);
});

test('retention: private receipts and erased bodies never enter public projections or scripts, and corruption fails closed', async () => {
  const { db, request, alice, bob } = await setup();
  const page = draft(); await request('POST', '/api/notebook', page, alice.key);
  const operation = retention(page); assert.equal((await retain(request, alice, operation)).status, 200);
  const before = copy(db.world), updates = db.updates;
  for (const route of ['/api/map', '/api/events', '/api/ledger', '/health', '/api/physics', '/.well-known/agent-world.json', '/mcp', '/skill.md', '/api/clock', '/api/me', '/api/perception']) {
    const out = await request('GET', route, undefined, alice.key);
    for (const privateValue of [operation.operation_id, page.page_id, page.id, page.title, page.body]) assert.equal(out.text.includes(privateValue), false, route);
  }
  assert.deepEqual((await request('GET', '/api/memory', undefined, bob.key)).json, []);
  for (const action of ['retention', 'forget', 'prune']) assert.equal((await request('POST', '/api/action',
    { action: 'pin', targetKind: 'thing', targetId: 't_board', verb: 'private_probe', instructions: [{ do: action }] }, alice.key)).status, 400);
  assert.deepEqual(db.world, before); assert.equal(db.updates, updates);
  db.world.memories.at(-1).tag = 'A'.repeat(22);
  const corrupt = copy(db.world);
  const refused = await request('POST', '/api/notebook', draft({ page_id: page.page_id }), alice.key);
  assert.equal(refused.status, 409); assert.equal(refused.json.error_class, 'memory_integrity'); assert.deepEqual(db.world, corrupt);
});

test('retention client: failed transport and unbound or content-bearing receipts never masquerade as a confirmed operation', async () => {
  const { request, alice } = await setup();
  const client = clientFor(request, alice, { mode: 'compatible' });
  const page = await client.save(client.prepare({ title: 'PRIVATE_TITLE', body: 'PRIVATE_BODY' }));
  const operation = client.prepareRetention({ action: 'forget', page_id: page.page_id, expected_head: page.id });
  const receipt = await client.retain(operation);
  for (const extra of [{ operation_id: id('ret') }, { page_id: id('page') }, { expected_head: id('mem') }, { retained_head: page.id }, { body: 'PRIVATE_BODY' }, { removed_count: -1 }]) {
    const liar = clientFor(request, alice, { mode: 'compatible', fetchImpl: async () => ({ status: 200, json: async () => ({ ok: true, retention: { ...receipt, ...extra } }) }) });
    await assert.rejects(liar.retain(operation), e => e.code === 'bad_response' && !e.message.includes('PRIVATE_'));
  }
  const offline = clientFor(request, alice, { mode: 'compatible', fetchImpl: async () => { throw new Error('PRIVATE_BODY'); } });
  await assert.rejects(offline.retain(operation), e => e.code === 'transport_unresolved' && !e.message.includes('PRIVATE_'));
});

test('daylight: exactly one injected UTC instant is used throughout each read and mutation', async () => {
  const { mod, request, alice } = await setup();
  let calls = 0;
  const start = Date.parse('2026-12-01T06:59:59.999Z');
  mod.__setClockForTests(() => new Date(start + calls++).toISOString());
  const perception = (await request('GET', '/api/perception', undefined, alice.key)).json;
  assert.equal(calls, 1); assert.equal(perception.clock.timestamp, perception.here.clock.timestamp);
  assert.equal(perception.clock.phase, 'sunrise');
  const look = (await request('POST', '/api/action', { action: 'look' }, alice.key)).json;
  assert.equal(calls, 2); assert.equal(look.event.createdAt, look.perception.clock.timestamp);
  assert.equal(look.perception.clock.phase, 'day');
});
