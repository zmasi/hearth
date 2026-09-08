import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { createSnapshot, verifySnapshot } from '../scripts/lib/recovery.mjs';
import { initialState, runOnce, validateConsent } from '../client/habitation.mjs';
import { buildModel, buildChronology } from '../observer/trails.mjs';

// Integration boundary only: real combined kernel, injected synthetic storage.
// No real credentials, network, activation, database connection or filesystem restore.
test('Integration: sequenced mentions survive recovery and still produce one previewed return packet', async () => {
  for (const key of ['DATABASE_URL', 'BLOB_READ_WRITE_TOKEN', 'VERCEL', 'HEARTH_DATA']) delete process.env[key];
  process.env.BLOB_STORE_ID = 'synthetic_resident_integration';
  async function boot(seed, suffix) {
    let bytes = seed;
    const api = await import(`../api/index.js?resident-integration=${suffix}`);
    api.__setBlobClientForTests({
      async get() { return bytes == null ? null : { stream: new Response(bytes).body }; },
      async put(_path, value) { bytes = value; },
    });
    async function request(method, url, body, key) {
      const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
      req.method = method; req.url = url; req.headers = { host: 'localhost' };
      if (key) req.headers.authorization = ['Bearer', key].join(' ');
      let status, text;
      await api.default(req, { writeHead(value) { status = value; }, end(value) { text = String(value); } });
      return { status, body: JSON.parse(text) };
    }
    return { request, world: () => JSON.parse(bytes), bytes: () => bytes };
  }
  const source = await boot(null, 'source');
  const writer = (await source.request('POST', '/api/join', { handle: 'integration_writer', kind: 'agent' })).body;
  const reader = (await source.request('POST', '/api/join', { handle: 'integration_reader', kind: 'agent' })).body;
  const cursor = (await source.request('GET', '/health')).body.world_sequence;
  assert.equal((await source.request('POST', '/api/action', { action: 'say', body: '@integration_reader synthetic invitation' }, writer.key)).status, 200);
  assert.equal((await source.request('POST', '/api/memory', { summary: 'SYNTHETIC_INTEGRATION_PRIVATE' }, reader.key)).status, 200);
  const before = source.world();
  const note = before.notes.find(n => n.body === '@integration_reader synthetic invitation');
  assert.ok(Number.isSafeInteger(note.seq));
  const archiveKey = randomBytes(32);
  const archive = createSnapshot(before, archiveKey);
  const restored = verifySnapshot(archive.bytes, archiveKey, archive.receipt.archive_sha256).payload.world;
  assert.deepEqual(restored, before);
  const target = await boot(JSON.stringify(restored), 'restored');
  const perception = await target.request('GET', `/api/perception?after=${cursor}`, undefined, reader.key);
  assert.equal(perception.status, 200);
  assert.equal(perception.body.mentions.length, 1);
  assert.equal(perception.body.mentions[0].seq, note.seq);
  const consent = validateConsent({ schema: 'hearth-habitation-consent-v1', handle: reader.handle,
    origin: 'http://127.0.0.1', key_file: 'synthetic-never-opened.key', enabled: true,
    wake: { on_mention: true }, budget: { max_wakes_per_day: 4, cooldown_minutes: 30 } });
  const state = { ...initialState(), after: cursor };
  const common = { consent, state, now: '2026-09-08T12:00:00.000Z', readKey: async () => reader.key,
    fetchImpl: async url => { const parsed = new URL(url); const out = await target.request('GET', parsed.pathname + parsed.search, undefined, reader.key); return { status: out.status, json: async () => out.body }; } };
  const durableBefore = target.bytes();
  const preview = await runOnce({ ...common, activate: false });
  assert.deepEqual(preview.state, state);
  assert.equal(preview.committed, false);
  let deliveries = 0;
  const activated = await runOnce({ ...common, state: preview.state, activate: true, dispatch: async () => { deliveries++; } });
  assert.equal(deliveries, 1);
  assert.equal(activated.committed, true);
  await runOnce({ ...common, state: activated.state, activate: true, dispatch: async () => { deliveries++; } });
  assert.equal(deliveries, 1);
  assert.equal(target.bytes(), durableBefore, 'perception/return decisions do not mutate the restored city');
  assert.equal(JSON.stringify(perception.body).includes('SYNTHETIC_INTEGRATION_PRIVATE'), false);
  assert.deepEqual(target.world().events, before.events);
  const map = (await target.request('GET', '/api/map')).body;
  const ledger = (await target.request('GET', '/api/ledger?after=0&limit=200')).body;
  const chronology = buildChronology(buildModel(map, ledger));
  const readNote = chronology.find(entry => entry.id === note.id);
  assert.ok(readNote, 'the restored invitation is readable in Trails');
  assert.equal(readNote.seq, note.seq, 'Trails preserves the new kernel-provided exact note sequence');
  assert.equal(JSON.stringify(chronology).includes('SYNTHETIC_INTEGRATION_PRIVATE'), false);
  assert.equal(target.bytes(), durableBefore, 'public reader inputs also leave the restored city unchanged');
});
