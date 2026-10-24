// Explicit owner operations only. No file/env access, key creation, logging,
// automatic capture, scheduling, or retry. Keep drafts in the owner's custody.
import { randomBytes } from 'node:crypto';
import { openMemory, sealMemory } from './vault.mjs';

const SCHEMA = 'hearth-notebook-v1';
const PAGE = /^page_[a-f0-9]{32}$/;
const VERSION = /^mem_[a-f0-9]{32}$/;
const RETENTION = /^ret_[a-f0-9]{32}$/;
const RETENTION_SCHEMA = 'hearth-notebook-retention-v1';
const pageIdentity = value => typeof value === 'string' && PAGE.test(value);
const versionIdentity = value => typeof value === 'string' && VERSION.test(value);
const problem = (code, status) => Object.assign(new Error(`Notebook operation failed (${code}).`), { code, status });
function textFields(title, body) {
  if (typeof title !== 'string' || !title.trim() || Buffer.byteLength(title) > 512
    || typeof body !== 'string' || Buffer.byteLength(body) > 60000) throw problem('bad_page');
}
function identity(pageId, previous) {
  if (!pageIdentity(pageId) || !(previous === null || versionIdentity(previous))) throw problem('bad_identity');
}
function retentionIntent(intent) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)
    || Object.keys(intent).length !== 4 || !['operation_id', 'action', 'page_id', 'expected_head'].every(k => Object.hasOwn(intent, k))
    || typeof intent.operation_id !== 'string' || !RETENTION.test(intent.operation_id)
    || !['forget', 'prune'].includes(intent.action) || !pageIdentity(intent.page_id) || !versionIdentity(intent.expected_head)) throw problem('bad_retention');
}

export function createNotebook({ origin, bearer, agentId, rootKey, mode = 'sealed', fetchImpl = globalThis.fetch }) {
  const url = new URL(origin);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw problem('bad_origin');
  if (typeof bearer !== 'string' || !bearer || /\s/.test(bearer) || !/^agt_[A-Za-z0-9_]{1,64}$/.test(agentId)) throw problem('bad_identity');
  if (!['sealed', 'compatible'].includes(mode)) throw problem('bad_mode');
  if (mode === 'sealed' && (!Buffer.isBuffer(rootKey) || rootKey.length !== 32)) throw problem('client_key_required');
  const base = url.origin;

  async function request(method, suffix, body) {
    let response, result;
    try {
      response = await fetchImpl(`${base}/api/notebook${suffix}`, { method, redirect: 'error', cache: 'no-store',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      result = await response.json();
    } catch { throw problem('transport_unresolved'); }
    if (response.status !== 200 || result?.ok !== true) {
      // Never reflect arbitrary response bodies, which can contain private text.
      if (response.status === 503) throw problem(result?.error_class === 'commit_outcome_unknown' ? 'commit_outcome_unknown' : 'storage_unresolved', 503);
      throw problem(response.status === 409 ? 'conflict_or_integrity' : 'request_rejected', response.status);
    }
    return result;
  }

  function open(record, expectedId, expectedPage) {
    try {
      if (!record || !versionIdentity(record.id) || record.id !== expectedId || record.visibility !== 'agent_private'
        || record.notebook?.schema !== SCHEMA || !Number.isFinite(Date.parse(record.createdAt))) throw problem('bad_record');
      const { page_id: pageId, previous } = record.notebook;
      identity(pageId, previous);
      if (expectedPage !== undefined && pageId !== expectedPage) throw problem('bad_record');
      let content;
      if (mode === 'sealed') {
        content = openMemory(rootKey, agentId, expectedId, record.sealed);
        if (content?.schema !== SCHEMA || content.page_id !== pageId || content.previous !== previous) throw problem('bad_record');
      } else {
        if (record.sealed) throw problem('bad_mode');
        content = record;
      }
      textFields(content.title, content.body);
      return { page_id: pageId, id: record.id, previous, title: content.title, body: content.body, date: record.createdAt };
    } catch { throw problem('unreadable_page'); }
  }

  function prepare({ page_id = `page_${randomBytes(16).toString('hex')}`, previous = null, title, body }) {
    identity(page_id, previous); textFields(title, body);
    return mode === 'sealed'
      ? { page_id, previous, sealed: sealMemory(rootKey, agentId, { schema: SCHEMA, page_id, previous, title, body }) }
      : { page_id, previous, id: `mem_${randomBytes(16).toString('hex')}`, title, body };
  }
  async function save(draft) {
    // Validate and bind even a draft loaded from the resident's own storage.
    identity(draft.page_id, draft.previous);
    const expectedId = mode === 'sealed' ? draft.sealed?.id : draft.id;
    let content;
    if (mode === 'sealed') {
      content = openMemory(rootKey, agentId, expectedId, draft.sealed);
      if (content?.schema !== SCHEMA || content.page_id !== draft.page_id || content.previous !== draft.previous) throw problem('bad_draft');
    } else { if (draft.sealed || !versionIdentity(expectedId)) throw problem('bad_draft'); content = draft; }
    textFields(content.title, content.body);
    const result = await request('POST', '', draft);
    const page = open(result.memory, expectedId, draft.page_id);
    if (page.previous !== draft.previous || page.title !== content.title || page.body !== content.body) throw problem('unreadable_page');
    return page;
  }
  async function read({ page_id, before, limit = 50 } = {}) {
    if (page_id !== undefined && !pageIdentity(page_id)) throw problem('bad_identity');
    if (before !== undefined && !versionIdentity(before)) throw problem('bad_cursor');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw problem('bad_limit');
    const query = new URLSearchParams({ limit: String(limit), mode });
    if (page_id !== undefined) query.set('page_id', page_id);
    if (before !== undefined) query.set('before', before);
    const result = await request('GET', `?${query}`);
    const records = page_id === undefined ? result.pages : result.versions;
    if (result.schema !== SCHEMA || !Array.isArray(records) || records.length > limit
      || !(result.next_before === null || versionIdentity(result.next_before))) throw problem('bad_response');
    // A list is a server-selected inventory, not a completeness/freshness proof.
    return { pages: records.map(rec => open(rec, rec.id, page_id)), next_before: result.next_before };
  }
  function prepareRetention({ action, page_id, expected_head, operation_id = `ret_${randomBytes(16).toString('hex')}` }) {
    const intent = { operation_id, action, page_id, expected_head };
    retentionIntent(intent); return intent;
  }
  async function retain(intent) {
    retentionIntent(intent);
    const { retention: receipt } = await request('POST', '/retention', intent);
    const fields = ['schema', 'operation_id', 'action', 'page_id', 'expected_head', 'removed_count', 'retained_head', 'applied_at'];
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || Object.keys(receipt).length !== fields.length
      || !fields.every(k => Object.hasOwn(receipt, k)) || receipt.schema !== RETENTION_SCHEMA
      || Object.keys(intent).some(k => receipt[k] !== intent[k])
      || !Number.isSafeInteger(receipt.removed_count) || receipt.removed_count < 0
      || receipt.retained_head !== (intent.action === 'prune' ? intent.expected_head : null)
      || typeof receipt.applied_at !== 'string' || !Number.isFinite(Date.parse(receipt.applied_at))) throw problem('bad_response');
    return receipt; // Body-free historical result, not a claim about later edits or backups.
  }
  return Object.freeze({ prepare, save, read, prepareRetention, retain });
}
