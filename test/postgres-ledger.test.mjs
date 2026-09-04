import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";

import seedHandler, { __setBlobClientForTests } from "../api/index.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function invokeRequest(handler, req) {
  return new Promise((resolve, reject) => {
    const responseHeaders = {};
    let response = null;
    let handlerComplete = false;
    const finish = () => {
      if (response && handlerComplete) resolve(response);
    };
    const res = {
      statusCode: 200,
      setHeader(name, value) {
        responseHeaders[String(name).toLowerCase()] = value;
      },
      writeHead(status, responseHeadersInput = {}) {
        this.statusCode = status;
        for (const [name, value] of Object.entries(responseHeadersInput)) {
          responseHeaders[String(name).toLowerCase()] = value;
        }
        return this;
      },
      end(payload = "") {
        const text = Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload);
        const json = responseHeaders["content-type"]?.includes("application/json") && text
          ? JSON.parse(text)
          : null;
        response = { status: this.statusCode, headers: responseHeaders, text, json };
        finish();
      },
    };
    Promise.resolve(handler(req, res)).then(() => {
      handlerComplete = true;
      finish();
    }, reject);
  });
}

function invoke(handler, method, url, body = undefined, headers = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(chunks);
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost", ...headers };
  return invokeRequest(handler, req);
}

class SeedBlob {
  constructor() {
    this.body = null;
    this.etag = "seed-etag-0";
    this.version = 0;
  }

  async get(_path, options = {}) {
    if (this.body === null) return null;
    if (options.ifNoneMatch === this.etag) {
      return { statusCode: 304, stream: null, blob: { etag: this.etag } };
    }
    return { statusCode: 200, stream: new Response(this.body).body, blob: { etag: this.etag } };
  }

  async put(_path, body) {
    this.body = body;
    this.version += 1;
    this.etag = `seed-etag-${this.version}`;
    return { pathname: "hearth.json" };
  }
}

async function freshSeed() {
  delete process.env.DATABASE_URL;
  delete process.env.VERCEL;
  process.env.BLOB_STORE_ID = "seed_store";
  delete process.env.BLOB_READ_WRITE_TOKEN;
  const blob = new SeedBlob();
  __setBlobClientForTests(blob);
  const health = await invoke(seedHandler, "GET", "/health");
  assert.equal(health.status, 200);
  return JSON.parse(blob.body);
}

function statementKind(text) {
  const sql = String(text).replace(/\s+/g, " ").trim().toUpperCase();
  if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return sql;
  if (sql.startsWith("SET LOCAL ")) return "SET_LOCAL";
  if (sql.startsWith("SELECT PG_ADVISORY_XACT_LOCK")) return "ADVISORY_LOCK";
  if (sql.startsWith("CREATE TABLE IF NOT EXISTS HEARTH_LEDGER")) return "CREATE_TABLE";
  if (sql.startsWith("SELECT WORLD") && sql.endsWith("FOR UPDATE")) return "SELECT_FOR_UPDATE";
  if (sql.startsWith("SELECT WORLD")) return "SELECT";
  if (sql.startsWith("INSERT INTO HEARTH_LEDGER")) return "INSERT";
  if (sql.startsWith("UPDATE HEARTH_LEDGER")) return "UPDATE";
  throw new Error(`Fake Postgres received unexpected SQL: ${sql}`);
}

class FakePostgresCluster {
  constructor(world, { rowExists = true } = {}) {
    this.world = world === null ? null : clone(world);
    this.rowExists = rowExists;
    this.revision = rowExists ? 1 : 0;
    this.migration = null;
    this.history = [];
    this.lockOwner = null;
    this.waiters = [];
    this.nextClientId = 1;
    this.nextCommitGate = null;
    this.failNextCommit = null;
    this.failNextCommitAfterApply = null;
    this.failNextRollback = null;
    this.releases = [];
  }

  pool(isolate) {
    return new FakePostgresPool(this, isolate);
  }

  deferNextCommit() {
    const gate = { entered: deferred(), release: deferred() };
    this.nextCommitGate = gate;
    return gate;
  }

  async lock(client) {
    if (!this.lockOwner) {
      this.lockOwner = client;
      return;
    }
    await new Promise((resolve) => this.waiters.push({ client, resolve }));
  }

  unlock(client) {
    assert.equal(this.lockOwner, client, "a transaction released a lock it did not own");
    const next = this.waiters.shift();
    if (next) {
      this.lockOwner = next.client;
      next.resolve();
    } else {
      this.lockOwner = null;
    }
  }
}

class FakePostgresPool {
  constructor(cluster, isolate) {
    this.cluster = cluster;
    this.isolate = isolate;
  }

  async connect() {
    return new FakePostgresClient(this.cluster, this.isolate);
  }

  async query(text, values) {
    const client = await this.connect();
    try {
      return await client.query(text, values);
    } finally {
      client.release();
    }
  }
}

class FakePostgresClient {
  constructor(cluster, isolate) {
    this.cluster = cluster;
    this.isolate = isolate;
    this.id = cluster.nextClientId++;
    this.inTransaction = false;
    this.hasLock = false;
    this.stagedWorld = null;
    this.released = false;
  }

  async query(text, values = []) {
    const kind = statementKind(text);
    this.cluster.history.push({ isolate: this.isolate, client: this.id, kind });

    if (kind === "BEGIN") {
      assert.equal(this.inTransaction, false);
      this.inTransaction = true;
      return { rows: [], rowCount: null };
    }

    if (kind === "SET_LOCAL" || kind === "ADVISORY_LOCK" || kind === "CREATE_TABLE") {
      assert.equal(this.inTransaction, true);
      return { rows: [], rowCount: kind === "CREATE_TABLE" ? null : 1 };
    }

    if (kind === "SELECT_FOR_UPDATE") {
      assert.equal(this.inTransaction, true);
      await this.cluster.lock(this);
      this.hasLock = true;
      this.stagedWorld = this.cluster.rowExists ? clone(this.cluster.world) : null;
      return {
        rows: this.cluster.rowExists ? [{ world: clone(this.stagedWorld) }] : [],
        rowCount: this.cluster.rowExists ? 1 : 0,
      };
    }

    if (kind === "SELECT") {
      return {
        rows: this.cluster.rowExists ? [{ world: clone(this.cluster.world) }] : [],
        rowCount: this.cluster.rowExists ? 1 : 0,
      };
    }

    if (kind === "INSERT") {
      assert.equal(this.inTransaction, true);
      assert.equal(this.hasLock, true);
      assert.equal(this.cluster.rowExists, false);
      this.stagedWorld = JSON.parse(values[1]);
      this.cluster.migration = { from: values[3], digest: values[4], etag: values[5] };
      return { rows: [], rowCount: 1 };
    }

    if (kind === "UPDATE") {
      assert.equal(this.inTransaction, true);
      assert.equal(this.hasLock, true);
      assert.equal(values[2], 1);
      this.stagedWorld = JSON.parse(values[0]);
      return { rows: [], rowCount: 1 };
    }

    if (kind === "COMMIT") {
      assert.equal(this.inTransaction, true);
      assert.equal(this.hasLock, true);
      const gate = this.cluster.nextCommitGate;
      this.cluster.nextCommitGate = null;
      if (gate) {
        gate.entered.resolve();
        await gate.release.promise;
      }
      if (this.cluster.failNextCommit) {
        const error = this.cluster.failNextCommit;
        this.cluster.failNextCommit = null;
        throw error;
      }
      this.cluster.world = clone(this.stagedWorld);
      this.cluster.rowExists = true;
      this.cluster.revision += 1;
      this.cluster.unlock(this);
      this.hasLock = false;
      this.inTransaction = false;
      if (this.cluster.failNextCommitAfterApply) {
        const error = this.cluster.failNextCommitAfterApply;
        this.cluster.failNextCommitAfterApply = null;
        throw error;
      }
      return { rows: [], rowCount: null };
    }

    if (kind === "ROLLBACK") {
      if (this.cluster.failNextRollback) {
        const error = this.cluster.failNextRollback;
        this.cluster.failNextRollback = null;
        throw error;
      }
      if (this.hasLock) {
        this.cluster.unlock(this);
        this.hasLock = false;
      }
      this.inTransaction = false;
      this.stagedWorld = null;
      return { rows: [], rowCount: null };
    }
  }

  release(destroy = false) {
    assert.equal(this.released, false, "database client released twice");
    if (destroy && this.hasLock) {
      this.cluster.unlock(this);
      this.hasLock = false;
      this.inTransaction = false;
    }
    assert.equal(this.inTransaction, false, "database client released with an open transaction");
    this.released = true;
    this.cluster.releases.push({ isolate: this.isolate, client: this.id, destroy });
  }
}

async function postgresIsolate(label, pool) {
  const module = await import(`../api/index.js?postgres-isolate=${label}`);
  module.__setPostgresPoolForTests(pool);
  return module.default;
}

function configurePostgresEnvironment() {
  process.env.DATABASE_URL = "postgresql://unit-test.invalid/hearth";
  delete process.env.HEARTH_MIGRATE_FROM_BLOB;
  delete process.env.HEARTH_MIGRATION_QUIET_MS;
  delete process.env.VERCEL;
  delete process.env.BLOB_STORE_ID;
  delete process.env.BLOB_READ_WRITE_TOKEN;
}

test("migration flag bootstraps an empty Postgres ledger from Blob exactly once", { concurrency: false }, async () => {
  const world = await freshSeed();
  configurePostgresEnvironment();
  process.env.HEARTH_MIGRATE_FROM_BLOB = "1";
  process.env.HEARTH_MIGRATION_QUIET_MS = "0";
  process.env.BLOB_STORE_ID = "migration_source";
  const cluster = new FakePostgresCluster(null, { rowExists: false });
  const module = await import("../api/index.js?postgres-isolate=bootstrap");
  const blob = new SeedBlob();
  blob.body = JSON.stringify(world);
  let blobReads = 0;
  const originalGet = blob.get.bind(blob);
  blob.get = async (...args) => {
    blobReads += 1;
    return originalGet(...args);
  };
  module.__setBlobClientForTests(blob);
  module.__setPostgresPoolForTests(cluster.pool("bootstrap"));

  try {
    const first = await invoke(module.default, "GET", "/health");
    assert.equal(first.status, 200);
    assert.equal(first.json.persist, "postgres");
    assert.equal(blobReads, 2);
    assert.deepEqual(cluster.world, world);
    assert.equal(cluster.revision, 1);
    assert.equal(cluster.migration.from, "vercel-blob:hearth.json");
    assert.match(cluster.migration.digest, /^[0-9a-f]{64}$/);
    assert.equal(cluster.migration.etag, blob.etag);
    assert.deepEqual(
      cluster.history.map((entry) => entry.kind),
      ["BEGIN", "SET_LOCAL", "SET_LOCAL", "ADVISORY_LOCK", "CREATE_TABLE", "SELECT_FOR_UPDATE", "INSERT", "COMMIT", "SELECT"],
    );

    const second = await invoke(module.default, "GET", "/health");
    assert.equal(second.status, 200);
    assert.equal(blobReads, 2);
    assert.equal(cluster.history.at(-1).kind, "SELECT");
  } finally {
    delete process.env.HEARTH_MIGRATE_FROM_BLOB;
    delete process.env.HEARTH_MIGRATION_QUIET_MS;
  }
});

test("migration imports the final Blob ETag after the source changes during drain", { concurrency: false }, async () => {
  const world = await freshSeed();
  const updatedWorld = clone(world);
  updatedWorld.notes.push({ id: "migration_race_note", placeId: "arrival", authorHandle: "hermes", body: "landed before cutover", createdAt: new Date().toISOString() });
  configurePostgresEnvironment();
  process.env.HEARTH_MIGRATE_FROM_BLOB = "1";
  process.env.HEARTH_MIGRATION_QUIET_MS = "0";
  process.env.BLOB_STORE_ID = "migration_source";
  const cluster = new FakePostgresCluster(null, { rowExists: false });
  const module = await import("../api/index.js?postgres-isolate=bootstrap-etag-change");
  const blob = new SeedBlob();
  blob.body = JSON.stringify(world);
  let conditionalReads = 0;
  let blobWrites = 0;
  const originalGet = blob.get.bind(blob);
  blob.get = async (path, options = {}) => {
    if (options.ifNoneMatch && conditionalReads++ === 0) {
      blob.body = JSON.stringify(updatedWorld);
      blob.etag = "seed-etag-updated";
    }
    return originalGet(path, options);
  };
  blob.put = async () => { blobWrites += 1; throw new Error("migration must not write Blob"); };
  module.__setBlobClientForTests(blob);
  module.__setPostgresPoolForTests(cluster.pool("bootstrap-etag-change"));

  try {
    const health = await invoke(module.default, "GET", "/health");
    assert.equal(health.status, 200);
    assert.deepEqual(cluster.world, updatedWorld);
    assert.equal(cluster.migration.etag, "seed-etag-updated");
    assert.equal(conditionalReads, 2);
    assert.equal(blobWrites, 0);
  } finally {
    delete process.env.HEARTH_MIGRATE_FROM_BLOB;
    delete process.env.HEARTH_MIGRATION_QUIET_MS;
  }
});

test("migration refuses a Blob world containing Postgres-incompatible NUL text", { concurrency: false }, async () => {
  const world = await freshSeed();
  world.notes.push({ id: "nul_note", placeId: "arrival", authorHandle: "hermes", body: "bad\u0000text", createdAt: new Date().toISOString() });
  configurePostgresEnvironment();
  process.env.HEARTH_MIGRATE_FROM_BLOB = "1";
  process.env.HEARTH_MIGRATION_QUIET_MS = "0";
  process.env.BLOB_STORE_ID = "migration_source";
  const cluster = new FakePostgresCluster(null, { rowExists: false });
  const module = await import("../api/index.js?postgres-isolate=bootstrap-nul");
  const blob = new SeedBlob();
  blob.body = JSON.stringify(world);
  module.__setBlobClientForTests(blob);
  module.__setPostgresPoolForTests(cluster.pool("bootstrap-nul"));

  try {
    const health = await invoke(module.default, "GET", "/health");
    assert.equal(health.status, 503);
    assert.equal(health.json.persist, "postgres-error");
    assert.match(health.json.persist_error, /NUL character/);
    assert.equal(cluster.rowExists, false);
    assert.equal(cluster.history.some((entry) => entry.kind === "INSERT"), false);
  } finally {
    delete process.env.HEARTH_MIGRATE_FROM_BLOB;
    delete process.env.HEARTH_MIGRATION_QUIET_MS;
  }
});

test("Postgres row locking retains concurrent writes from separate isolates", { concurrency: false }, async () => {
  const world = await freshSeed();
  configurePostgresEnvironment();
  const cluster = new FakePostgresCluster(world);
  const firstHandler = await postgresIsolate("concurrency-a", cluster.pool("a"));
  const secondHandler = await postgresIsolate("concurrency-b", cluster.pool("b"));

  const [first, second] = await Promise.all([
    invoke(firstHandler, "POST", "/api/join", { handle: "isolate_alpha", kind: "agent" }),
    invoke(secondHandler, "POST", "/api/join", { handle: "isolate_beta", kind: "agent" }),
  ]);

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.ok(cluster.world.residents.some((resident) => resident.handle === "isolate_alpha"));
  assert.ok(cluster.world.residents.some((resident) => resident.handle === "isolate_beta"));
  assert.equal(cluster.revision, 3);

  for (const isolate of ["a", "b"]) {
    assert.deepEqual(
      cluster.history.filter((entry) => entry.isolate === isolate).map((entry) => entry.kind),
      ["BEGIN", "SET_LOCAL", "SET_LOCAL", "SELECT_FOR_UPDATE", "UPDATE", "COMMIT"],
    );
  }
});

test("Postgres success waits for COMMIT and rejected mutations ROLLBACK without writes", { concurrency: false }, async () => {
  const world = await freshSeed();
  configurePostgresEnvironment();
  const cluster = new FakePostgresCluster(world);
  const handler = await postgresIsolate("commit-and-rollback", cluster.pool("single"));

  const gate = cluster.deferNextCommit();
  let settled = false;
  const request = invoke(handler, "POST", "/api/join", { handle: "commit_probe", kind: "agent" });
  request.then(() => { settled = true; }, () => { settled = true; });
  await gate.entered.promise;
  await Promise.resolve();
  assert.equal(settled, false, "request returned success before COMMIT resolved");
  gate.release.resolve();
  assert.equal((await request).status, 201);

  const historyBeforeReject = cluster.history.length;
  const snapshotBeforeReject = JSON.stringify(cluster.world);
  const rejected = await invoke(handler, "POST", "/api/join", { handle: "human_probe", kind: "human" });
  assert.equal(rejected.status, 403);
  assert.equal(JSON.stringify(cluster.world), snapshotBeforeReject);
  assert.deepEqual(
    cluster.history.slice(historyBeforeReject).map((entry) => entry.kind),
    ["BEGIN", "SET_LOCAL", "SET_LOCAL", "SELECT_FOR_UPDATE", "ROLLBACK"],
  );
});

test("pre-ack commit failures return outcome-unknown, destroy the client, and leave current health truthful", { concurrency: false }, async () => {
  const world = await freshSeed();
  configurePostgresEnvironment();
  const cluster = new FakePostgresCluster(world);
  const handler = await postgresIsolate("commit-failure", cluster.pool("failure"));
  cluster.failNextCommit = new Error("synthetic commit outage");

  const failed = await invoke(handler, "POST", "/api/join", { handle: "commit_retry", kind: "agent" });
  assert.equal(failed.status, 503);
  assert.equal(failed.json.error_class, "commit_outcome_unknown");
  assert.match(failed.json.message, /may have been applied/);
  assert.equal(cluster.world.residents.some((resident) => resident.handle === "commit_retry"), false);
  assert.ok(cluster.releases.some((release) => release.destroy), "ambiguous COMMIT client was reused");

  const health = await invoke(handler, "GET", "/health");
  assert.equal(health.status, 200);
  assert.equal(health.json.persist, "postgres");

  const retried = await invoke(handler, "POST", "/api/join", { handle: "commit_retry", kind: "agent" });
  assert.equal(retried.status, 201);
});

test("a post-commit disconnect is reconciled so a joined resident receives its key", { concurrency: false }, async () => {
  const world = await freshSeed();
  configurePostgresEnvironment();
  const cluster = new FakePostgresCluster(world);
  const handler = await postgresIsolate("commit-after-apply", cluster.pool("after-apply"));
  cluster.failNextCommitAfterApply = new Error("synthetic lost commit acknowledgement");

  const joined = await invoke(handler, "POST", "/api/join", { handle: "reconciled_join", kind: "agent" });
  assert.equal(joined.status, 201);
  assert.ok(joined.json.key);
  const resident = cluster.world.residents.find((row) => row.handle === "reconciled_join");
  assert.ok(resident?.keyHash);
  assert.ok(cluster.releases.some((release) => release.destroy), "ambiguous COMMIT client was reused");
  assert.equal((await invoke(handler, "GET", "/health")).status, 200);
});

test("every rejected Postgres mutation rolls back, and rollback failure destroys the client", { concurrency: false }, async () => {
  const world = await freshSeed();
  configurePostgresEnvironment();
  const cluster = new FakePostgresCluster(world);
  const handler = await postgresIsolate("early-returns", cluster.pool("early"));

  for (const [path, body, headers, status] of [
    ["/api/join", { handle: "human_probe", kind: "human" }, {}, 403],
    ["/api/action", { action: "no_op" }, {}, 401],
    ["/api/memory", { summary: "private" }, {}, 401],
    ["/api/memory", { summary: "private" }, { authorization: "Bearer unknown" }, 401],
  ]) {
    const before = cluster.history.length;
    const response = await invoke(handler, "POST", path, body, headers);
    assert.equal(response.status, status);
    assert.deepEqual(
      cluster.history.slice(before).map((entry) => entry.kind),
      ["BEGIN", "SET_LOCAL", "SET_LOCAL", "SELECT_FOR_UPDATE", "ROLLBACK"],
    );
  }

  cluster.failNextRollback = new Error("synthetic rollback outage");
  const failed = await invoke(handler, "POST", "/api/memory", { summary: "private" });
  assert.equal(failed.status, 503);
  assert.equal(failed.json.error_class, "ledger_unavailable");
  assert.ok(cluster.releases.some((release) => release.destroy), "rollback-failed client was reused");

  const next = await invoke(handler, "POST", "/api/join", { handle: "after_rollback", kind: "agent" });
  assert.equal(next.status, 201);
});

test("request bodies are bounded and parsed before the row lock", { concurrency: false }, async () => {
  const world = await freshSeed();
  configurePostgresEnvironment();
  const cluster = new FakePostgresCluster(world);
  const slowHandler = await postgresIsolate("slow-body", cluster.pool("slow"));
  const fastHandler = await postgresIsolate("fast-body", cluster.pool("fast"));

  const slowRequest = new PassThrough();
  slowRequest.method = "POST";
  slowRequest.url = "/api/join";
  slowRequest.headers = { host: "localhost" };
  const slowResponse = invokeRequest(slowHandler, slowRequest);
  slowRequest.write('{"handle":"slow_human",');
  await Promise.resolve();

  const fastResponse = await invoke(fastHandler, "POST", "/api/join", { handle: "fast_writer", kind: "agent" });
  assert.equal(fastResponse.status, 201, "a partial request body held the Postgres row lock");
  slowRequest.end('"kind":"human"}');
  assert.equal((await slowResponse).status, 403);

  const beforeNul = cluster.history.length;
  const nul = await invoke(fastHandler, "POST", "/api/action", { action: "say", body: "not\u0000jsonb" });
  assert.equal(nul.status, 400);
  assert.equal(nul.json.error_class, "bad_input");
  assert.deepEqual(cluster.history.slice(beforeNul).map((entry) => entry.kind), ["SELECT"]);

  const beforeLarge = cluster.history.length;
  const large = await invoke(fastHandler, "POST", "/api/action", { body: "x".repeat(129 * 1024) });
  assert.equal(large.status, 413);
  assert.equal(large.json.error_class, "payload_too_large");
  assert.deepEqual(cluster.history.slice(beforeLarge).map((entry) => entry.kind), ["SELECT"]);
});

test("Postgres health converges across isolates after another isolate writes successfully", { concurrency: false }, async () => {
  const world = await freshSeed();
  configurePostgresEnvironment();
  const cluster = new FakePostgresCluster(world);
  const firstHandler = await postgresIsolate("health-a", cluster.pool("health-a"));
  const secondHandler = await postgresIsolate("health-b", cluster.pool("health-b"));
  cluster.failNextCommit = new Error("synthetic commit outage");

  assert.equal((await invoke(firstHandler, "POST", "/api/join", { handle: "uncertain_join", kind: "agent" })).status, 503);
  assert.equal((await invoke(secondHandler, "POST", "/api/join", { handle: "healthy_join", kind: "agent" })).status, 201);
  for (const handler of [firstHandler, secondHandler]) {
    const health = await invoke(handler, "GET", "/health");
    assert.equal(health.status, 200);
    assert.equal(health.json.persist, "postgres");
  }
});

test("a configured but unavailable Postgres ledger never falls back to Blob", { concurrency: false }, async () => {
  const world = await freshSeed();
  configurePostgresEnvironment();
  process.env.BLOB_STORE_ID = "rollback_snapshot";
  const blob = new SeedBlob();
  blob.body = JSON.stringify(world);
  const module = await import("../api/index.js?postgres-isolate=no-fallback");
  module.__setBlobClientForTests(blob);
  module.__setPostgresPoolForTests({
    async query() {
      throw new Error("synthetic database outage");
    },
  });

  const health = await invoke(module.default, "GET", "/health");
  assert.equal(health.status, 503);
  assert.equal(health.json.persist, "postgres-error");
  assert.equal(health.json.database_url, true);
  assert.equal(health.json.blob_store, true);
});
