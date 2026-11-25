import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const STATES = new Set(['queued', 'running', 'paused', 'review', 'completed', 'failed', 'uncertain']);
const ACTIVE = "('queued','running','paused','uncertain')";
const APPLICATION_ID = 0x50505255; // PPRU: a separate generation-runs.sqlite, never the page/credential database.
const DEFAULT_LEASE_MS = 180000;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('VALIDATION', 'A plain JSON object is required.');
  return value;
}
function fields(value, allowed) { object(value); if (Object.keys(value).some(key => !allowed.includes(key))) fail('VALIDATION', 'Unknown run field.'); return value; }
function text(value, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail('VALIDATION', 'A bounded nonempty string is required.');
  return value;
}
function integer(value, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) fail('VALIDATION', 'An integer is outside its permitted range.'); return value; }
function json(value, limit = 2 * 1024 * 1024) {
  let count = 0;
  const visit = (item, depth) => {
    if (++count > 200000 || depth > 70) fail('VALIDATION', 'Run JSON is too complex.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (Array.isArray(item)) { for (const child of item) visit(child, depth + 1); return; }
    object(item);
    for (const [key, child] of Object.entries(item)) {
      if (/^(?:authorization|apikey|openaiapikey|username|password|applicationpassword|credentials?|secret|masterkey|privatekey|ciphertext|__proto__|constructor|prototype)$/i.test(key.replace(/[-_ ]/g, ''))) fail('VALIDATION', 'Credential fields must not be saved in a run.');
      visit(child, depth + 1);
    }
  };
  try { visit(value, 0); } catch (error) { if (error.code) throw error; fail('VALIDATION', 'Only bounded JSON values may be saved.'); }
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, 'utf8') > limit) fail('VALIDATION', 'Run JSON exceeds the size limit.');
  return JSON.parse(encoded);
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function specValue(input) {
  fields(input, ['pageId', 'sourceRevision', 'siteId', 'status', 'brief', 'batches', 'generation', 'launch']);
  const value = json({ ...input, siteId: input.siteId ?? null, brief: input.brief ?? {}, generation: input.generation ?? {} }, 16 * 1024 * 1024);
  text(value.pageId); integer(value.sourceRevision, 1, Number.MAX_SAFE_INTEGER);
  if (!['review', 'draft', 'publish'].includes(value.status)) fail('VALIDATION', 'Run status must be review, draft or publish.');
  if (value.siteId !== null) text(value.siteId);
  if (value.status !== 'review' && value.siteId === null) fail('VALIDATION', 'A publication site is required.');
  object(value.brief); object(value.generation); if (own(value, 'launch')) object(value.launch);
  if (!Array.isArray(value.batches) || value.batches.length > 100) fail('VALIDATION', 'Use zero to 100 prepared generation batches.');
  for (const batch of value.batches) if (!Array.isArray(batch)) object(batch);
  return value;
}
function errorValue(value) {
  if (value === null) return null;
  fields(value, ['code', 'message', 'retryable']);
  if(value.retryable!==undefined&&typeof value.retryable!=='boolean')fail('VALIDATION','Retryability must be boolean.'); text(value.code, 100);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(value.code)) fail('VALIDATION', 'A safe error code is required.');
  const message = value.message ?? value.code; text(message, 2000); return { code: value.code, message, ...(value.retryable===undefined?{}:{retryable:value.retryable}) };
}

/**
 * Durable local run storage only: this module never dispatches AI or writes to WordPress.
 * createRun({projectId,idempotencyKey,spec}) stores an immutable detached launch snapshot.
 * spec = {pageId,sourceRevision,siteId,status,brief?,batches:[],generation?,launch?}; generation is opaque.
 * claimRun({workerId,leaseMs?}) returns the only active lease, including its private leaseToken.
 * finishBatch(id,{leaseToken,batchIndex,requestId,result,validated:true,jobResult?}) is the trusted
 * executor boundary: callers must validate model output before submitting a checkpoint. This
 * store enforces order, fencing and immutability, not model semantics. It advances the cursor
 * and records the result in one transaction. Budget replay decides whether a missing batch
 * may be dispatched; lease recovery alone never authorizes an API retry.
 * transition(id,{leaseToken,state,stage?,result?,error?}) allows queued/running/review/completed/failed/
 * uncertain. queued releases the lease to yield after a batch; running retains it for apply/publication stages. Final page writes belong
 * to the main store's generation receipt transaction, then this store can mark completion.
 * pauseRun/resumeRun(id,{expectedRevision}); failed runs require an explicit coordinator-proved allowFailedRetry and stored retryability. Unknown/review/completed never resume.
 * recoverExpiredRuns() returns recovered queued records. assertLease(id,token) checks live ownership
 * without exposing tokens through getRun/listRuns. cursor aliases nextBatchIndex for the coordinator.
 * All returned snapshots are detached; results and launch specs are never patched in place.
 */
export function createRunStore({ filename, clock = Date.now } = {}) {
  text(filename, 32000); if (typeof clock !== 'function') fail('VALIDATION', 'Clock must be a function.');
  const millis = () => { const time = clock(); if (typeof time !== 'number' || !Number.isFinite(time) || !Number.isFinite(new Date(time).getTime())) fail('VALIDATION', 'Clock returned an invalid timestamp.'); return time; };
  millis(); if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename); let closed = false;
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const assertOpen = () => { if (closed) fail('CLOSED', 'Run store is closed.'); };
  const transaction = callback => {
    assertOpen(); db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    const app = one('PRAGMA application_id').application_id, version = one('PRAGMA user_version').user_version;
    if ((app !== 0 && app !== APPLICATION_ID) || version > 2 || (app === 0 && one("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"))) fail('VALIDATION', 'The file is not a compatible generation run database.');
    db.exec('PRAGMA journal_mode=WAL; BEGIN IMMEDIATE;');
    db.exec("CREATE TABLE IF NOT EXISTS generation_runs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,spec_hash TEXT NOT NULL,spec_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('queued','running','paused','review','completed','failed','uncertain')),stage TEXT NOT NULL,next_batch INTEGER NOT NULL DEFAULT 0,attempt INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,worker_id TEXT,lease_token TEXT,lease_until INTEGER,result_json TEXT,error_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS generation_batches(run_id TEXT NOT NULL REFERENCES generation_runs(id),batch_index INTEGER NOT NULL,request_id TEXT NOT NULL,result_json TEXT NOT NULL,job_result_json TEXT,completed_at TEXT NOT NULL,PRIMARY KEY(run_id,batch_index),UNIQUE(run_id,request_id));" +
      "CREATE UNIQUE INDEX IF NOT EXISTS generation_one_running ON generation_runs((1)) WHERE state='running';" +
      'CREATE INDEX IF NOT EXISTS generation_project ON generation_runs(project_id,state);');
    if(!db.prepare('PRAGMA table_info(generation_runs)').all().some(column=>column.name==='retry_count'))db.exec('ALTER TABLE generation_runs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0');
    // Keep schema creation, column upgrades and version publication atomic. An
    // unchanged open still validates every object without rewriting WAL frames.
    if(app!==APPLICATION_ID)db.exec('PRAGMA application_id=' + APPLICATION_ID);
    if(version!==2)db.exec('PRAGMA user_version=2');
    db.exec('COMMIT');
  } catch (error) { try{db.exec('ROLLBACK');}catch{} db.close(); throw error; }
  const rowFor = id => { text(id); const row = one('SELECT * FROM generation_runs WHERE id=?', id); if (!row) fail('NOT_FOUND', 'Run was not found.'); return row; };
  const decoded = (row, includeLease = false) => {
    if (!row) return null;
    return { id: row.id, projectId: row.project_id, idempotencyKey: row.idempotency_key, spec: JSON.parse(row.spec_json), state: row.state, retryCount:row.retry_count,retryable:row.state==='failed'&&row.retry_count<2&&JSON.parse(row.error_json||'null')?.retryable===true,stage: row.stage, nextBatchIndex: row.next_batch, cursor: row.next_batch, attempt: row.attempt, revision: row.revision,
      workerId: row.worker_id, leaseUntil: row.lease_until === null ? null : new Date(row.lease_until).toISOString(), ...(includeLease && row.lease_token ? { leaseToken: row.lease_token } : {}),
      result: row.result_json === null ? null : JSON.parse(row.result_json), error: row.error_json === null ? null : JSON.parse(row.error_json), createdAt: row.created_at, updatedAt: row.updated_at,
      batchResults: all('SELECT * FROM generation_batches WHERE run_id=? ORDER BY batch_index', row.id).map(batch => ({ batchIndex: batch.batch_index, requestId: batch.request_id, validated: true, result: JSON.parse(batch.result_json), jobResult: batch.job_result_json === null ? null : JSON.parse(batch.job_result_json), completedAt: batch.completed_at })) };
  };
  const checkRevision = (row, expected) => { integer(expected, 1, Number.MAX_SAFE_INTEGER); if (row.revision !== expected) fail('CONFLICT', 'Run changed. Reload it before continuing.'); };
  const leased = (id, token) => { const row = rowFor(id); if (row.state !== 'running' || typeof token !== 'string' || !token || row.lease_token !== token || row.lease_until <= millis()) fail('LEASE_CONFLICT', 'The run lease is expired, paused or owned by another worker.'); return row; };
  const leaseDuration = value => integer(value ?? DEFAULT_LEASE_MS, 1000, 900000);
  const release = (row, state, error = row.error_json, stage = row.stage, result = row.result_json) => {
    run('UPDATE generation_runs SET state=?,stage=?,result_json=?,error_json=?,worker_id=NULL,lease_token=NULL,lease_until=NULL,revision=revision+1,updated_at=? WHERE id=?', state, stage, result, error, new Date(millis()).toISOString(), row.id);
    return decoded(rowFor(row.id));
  };
  return Object.freeze({
    createRun(input) {
      fields(input, ['projectId', 'idempotencyKey', 'spec', 'id']); text(input.projectId); text(input.idempotencyKey);
      if (input.id !== undefined && (typeof input.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.id))) fail('VALIDATION', 'Invalid run identity.');
      const spec = specValue(input.spec), hash = createHash('sha256').update(canonical({ projectId: input.projectId, spec })).digest('hex');
      return transaction(() => {
        const old = one('SELECT * FROM generation_runs WHERE idempotency_key=?', input.idempotencyKey);
        if (old) { if (old.spec_hash !== hash || (input.id !== undefined && input.id !== old.id)) fail('CONFLICT', 'The launch ID already belongs to a different immutable specification.'); return decoded(old); }
        if (one('SELECT COUNT(*) AS count FROM generation_runs WHERE state IN ' + ACTIVE).count >= 100) fail('QUEUE_FULL', 'There are already 100 unfinished automation runs.');
        const id = input.id ?? randomUUID(), time = new Date(millis()).toISOString();
        if (one('SELECT id FROM generation_runs WHERE id=?', id)) fail('CONFLICT', 'Run identity already belongs to another launch.');
        run("INSERT INTO generation_runs(id,project_id,idempotency_key,spec_hash,spec_json,state,stage,created_at,updated_at) VALUES(?,?,?,?,?,'queued','generation',?,?)", id, input.projectId, input.idempotencyKey, hash, JSON.stringify(spec), time, time);
        return decoded(rowFor(id));
      });
    },
    assertLease(id, leaseToken) { assertOpen(); return decoded(leased(id, leaseToken)); },
    getRun(id) { assertOpen(); text(id); return decoded(one('SELECT * FROM generation_runs WHERE id=?', id)); },
    getRunByKey(key){assertOpen();text(key,500);return decoded(one('SELECT * FROM generation_runs WHERE idempotency_key=?',key));},
    listRuns(projectId, options = {}) {
      assertOpen(); fields(options, ['states', 'limit', 'pageId']); const where = [], args = [];
      if (projectId !== undefined && projectId !== null) { text(projectId); where.push('project_id=?'); args.push(projectId); }
      if(options.pageId!==undefined){text(options.pageId);where.push("json_extract(spec_json,'$.pageId')=?");args.push(options.pageId);}
      if (options.states !== undefined) { if (!Array.isArray(options.states) || !options.states.length || options.states.length > STATES.size || options.states.some(state => !STATES.has(state)) || new Set(options.states).size !== options.states.length) fail('VALIDATION', 'Unknown run state filter.'); where.push('state IN (' + options.states.map(() => '?').join(',') + ')'); args.push(...options.states); }
      args.push(integer(options.limit ?? 100, 1, 1000));
      return all('SELECT * FROM generation_runs' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY created_at,rowid LIMIT ?', ...args).map(row => decoded(row));
    },
    claimRun(input) {
      fields(input, ['workerId', 'leaseMs']); text(input.workerId); const duration = leaseDuration(input.leaseMs);
      return transaction(() => {
        if (one("SELECT id FROM generation_runs WHERE state='running'")) return null;
        const row = one("SELECT * FROM generation_runs WHERE state='queued' ORDER BY updated_at,rowid LIMIT 1"); if (!row) return null;
        const time = millis(), token = randomUUID();
        run("UPDATE generation_runs SET state='running',worker_id=?,lease_token=?,lease_until=?,attempt=attempt+1,revision=revision+1,updated_at=? WHERE id=?", input.workerId, token, time + duration, new Date(time).toISOString(), row.id);
        return decoded(rowFor(row.id), true);
      });
    },
    renewRun(id, input) {
      fields(input, ['leaseToken', 'leaseMs']); const duration = leaseDuration(input.leaseMs);
      return transaction(() => { const row = leased(id, input.leaseToken), time = millis(); run('UPDATE generation_runs SET lease_until=?,revision=revision+1,updated_at=? WHERE id=?', Math.max(row.lease_until, time + duration), new Date(time).toISOString(), row.id); return decoded(rowFor(id), true); });
    },
    finishBatch(id, input) {
      fields(input, ['leaseToken', 'batchIndex', 'requestId', 'result', 'validated', 'jobResult']); integer(input.batchIndex, 0, 99); text(input.requestId, 100);
      if (input.validated !== true) fail('VALIDATION', 'Only a validated generation result can advance the batch cursor.');
      const result = json(input.result), jobResult = input.jobResult === undefined || input.jobResult === null ? null : json(input.jobResult);
      return transaction(() => {
        const row = leased(id, input.leaseToken), total = JSON.parse(row.spec_json).batches.length;
        if (input.batchIndex >= total || input.batchIndex > row.next_batch) fail('CONFLICT', 'The batch does not match the current cursor.');
        const old = one('SELECT * FROM generation_batches WHERE run_id=? AND batch_index=?', id, input.batchIndex);
        if (old) { if (old.request_id !== input.requestId || canonical(JSON.parse(old.result_json)) !== canonical(result) || canonical(old.job_result_json === null ? null : JSON.parse(old.job_result_json)) !== canonical(jobResult)) fail('CONFLICT', 'A saved batch result cannot be rewritten.'); return decoded(row); }
        if (input.batchIndex !== row.next_batch || one('SELECT 1 FROM generation_batches WHERE run_id=? AND request_id=?', id, input.requestId)) fail('CONFLICT', 'The batch or AI request identity was already committed.');
        const time = new Date(millis()).toISOString();
        run('INSERT INTO generation_batches(run_id,batch_index,request_id,result_json,job_result_json,completed_at) VALUES(?,?,?,?,?,?)', id, input.batchIndex, input.requestId, JSON.stringify(result), jobResult === null ? null : JSON.stringify(jobResult), time);
        run('UPDATE generation_runs SET next_batch=next_batch+1,revision=revision+1,updated_at=? WHERE id=?', time, id);
        return decoded(rowFor(id));
      });
    },
    transition(id, input) {
      fields(input, ['leaseToken', 'state', 'stage', 'result', 'error']);
      if (!['queued', 'running', 'review', 'completed', 'failed', 'uncertain'].includes(input.state)) fail('VALIDATION', 'Unsupported worker transition.');
      if (own(input, 'stage')) text(input.stage, 100);
      const result = own(input, 'result') ? JSON.stringify(json(input.result)) : undefined;
      const error = own(input, 'error') ? JSON.stringify(errorValue(input.error)) : undefined;
      return transaction(() => {
        const row = leased(id, input.leaseToken);
        if (['review', 'completed'].includes(input.state) && row.next_batch !== JSON.parse(row.spec_json).batches.length) fail('CONFLICT', 'All generation batches must be checkpointed before completion.');
        const nextResult = result === undefined ? row.result_json : result, nextError = error === undefined ? row.error_json : error, stage = input.stage ?? row.stage;
        if (input.state !== 'running') return release(row, input.state, nextError, stage, nextResult);
        run('UPDATE generation_runs SET stage=?,result_json=?,error_json=?,revision=revision+1,updated_at=? WHERE id=?', stage, nextResult, nextError, new Date(millis()).toISOString(), id);
        return decoded(rowFor(id), true);
      });
    },
    pauseRun(id, input) {
      fields(input, ['expectedRevision']);
      return transaction(() => { const row = rowFor(id); checkRevision(row, input.expectedRevision); if (!['queued', 'running', 'paused'].includes(row.state)) fail('CONFLICT', 'Only queued or running work can be paused.'); return row.state === 'paused' ? decoded(row) : release(row, 'paused'); });
    },
    resumeRun(id, input) {
      fields(input, ['expectedRevision','allowFailedRetry']);
      return transaction(() => { const row = rowFor(id); checkRevision(row, input.expectedRevision);
        const failed=row.state==='failed'&&input.allowFailedRetry===true&&decoded(row).retryable;
        if(row.state!=='paused'&&!failed)fail('CONFLICT','Only a paused or proved-safe failed run may resume. Unknown outcomes require reconciliation.');
        if(failed&&one("SELECT COUNT(*) AS count FROM generation_runs WHERE state IN "+ACTIVE).count>=100)fail('QUEUE_FULL','There are already 100 unfinished runs.');
        if(failed)run('UPDATE generation_runs SET retry_count=retry_count+1 WHERE id=?',id);
        return release(row,'queued',null);
      });
    },
    recoverExpiredRuns() {
      return transaction(() => all("SELECT * FROM generation_runs WHERE state='running' AND lease_until<=? ORDER BY created_at,rowid", millis()).map(row => release(row, 'queued', JSON.stringify({ code: 'LEASE_EXPIRED', message: 'The previous worker lease expired. Keep the original request identities and consult budget replay before dispatch.' }))));
    },
    close() { if (!closed) { db.close(); closed = true; } }
  });
}
