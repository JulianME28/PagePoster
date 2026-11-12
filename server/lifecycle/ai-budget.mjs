import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Standard text API rates, verified 2026-10-15. No cached-input discount is assumed.
// https://developers.openai.com/api/docs/models/gpt-5.4-mini
// GPT-4.1 mini rates verified 2026-10-20: https://developers.openai.com/api/docs/models/gpt-4.1-mini
export const DEFAULT_AI_RATES = Object.freeze({
  'gpt-4.1-mini': Object.freeze({ inputUSDPerMillion: 0.40, outputUSDPerMillion: 1.60 }),
  'gpt-5.4-mini': Object.freeze({ inputUSDPerMillion: 0.75, outputUSDPerMillion: 4.50 })
});
const NANO_USD = 1000000000;
const INPUT_OVERHEAD_TOKENS = 4096;
const MAX_OUTPUT_TOKENS = 12000;
const RELEASE_CODES = new Set(['HTTP_400', 'HTTP_401', 'HTTP_403', 'HTTP_404', 'HTTP_422', 'HTTP_429', 'CANCELLED_BEFORE_DISPATCH']);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('VALIDATION', 'An object is required.');
  return value;
}
function fields(value, allowed) {
  object(value);
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('VALIDATION', 'Unknown ledger field.');
}
function integer(value, max = 1000000000) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) fail('VALIDATION', 'Invalid bounded integer.');
  return value;
}
function string(value, max = 200) {
  if (typeof value !== 'string' || !value || value.length > max) fail('VALIDATION', 'Invalid string.');
  return value;
}
function jsonValue(value, max = 2000000) {
  let count = 0;
  const visit = (item, depth) => {
    if (++count > 100000 || depth > 50) fail('VALIDATION', 'Ledger JSON is too complex.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (Array.isArray(item)) { item.forEach(child => visit(child, depth + 1)); return; }
    object(item);
    for (const [key, child] of Object.entries(item)) {
      if (/^(?:authorization|apikey|openaiapikey|password|applicationpassword|credentials?|secret|ciphertext|__proto__|constructor|prototype)$/i.test(key.replace(/[-_ ]/g, ''))) fail('VALIDATION', 'Credential fields do not belong in the AI ledger.');
      visit(child, depth + 1);
    }
  };
  try { visit(value, 0); } catch (error) { if (error.code) throw error; fail('VALIDATION', 'Only bounded JSON values are accepted.'); }
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, 'utf8') > max) fail('VALIDATION', 'Ledger JSON is too large.');
  return JSON.parse(encoded);
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function safeCost(inputTokens, outputTokens, inputRate, outputRate) {
  const cost = inputTokens * inputRate + outputTokens * outputRate;
  if (!Number.isSafeInteger(cost) || cost < 0) fail('VALIDATION', 'Cost exceeds supported integer precision.');
  return cost;
}
function usageValue(value) {
  object(value);
  // Responses may include additional usage details; only these two authoritative totals are billed.
  return { input_tokens: integer(value.input_tokens), output_tokens: integer(value.output_tokens) };
}
function requestValue(input) {
  const value = jsonValue(input, 1000000);
  fields(value, ['model', 'store', 'instructions', 'input', 'max_output_tokens', 'text', 'reasoning', 'temperature', 'top_p']);
  string(value.model, 200);
  if (typeof value.input !== 'string' || (value.instructions !== undefined && typeof value.instructions !== 'string') || value.store !== false) fail('VALIDATION', 'The ledger supports only non-stored text requests.');
  integer(value.max_output_tokens, MAX_OUTPUT_TOKENS);
  if (value.max_output_tokens < 1) fail('VALIDATION', 'A bounded output token limit is required.');
  return value;
}

/**
 * Local request budget only: no API key, network calls, prompt text or automatic retry.
 * Each reservation is a one-time dispatch capability. Keep its returned token internal.
 */
export function createAIBudget({ filename, monthlyUSD = 10, monthlyTokens = 2000000, rates = {}, clock = Date.now } = {}) {
  string(filename, 32000);
  if (typeof monthlyUSD !== 'number' || !Number.isFinite(monthlyUSD) || monthlyUSD <= 0 || monthlyUSD > 1000000) fail('VALIDATION', 'Monthly USD limit must be positive and bounded.');
  const limitNanos = Math.floor(monthlyUSD * NANO_USD);
  if (limitNanos < 1 || integer(monthlyTokens) < 1 || typeof clock !== 'function') fail('VALIDATION', 'Monthly token limit and clock are required.');
  object(rates);
  const configuredRates = new Map();
  for (const [model, rate] of Object.entries({ ...DEFAULT_AI_RATES, ...rates })) {
    string(model, 200); fields(rate, ['inputUSDPerMillion', 'outputUSDPerMillion']);
    for (const amount of [rate.inputUSDPerMillion, rate.outputUSDPerMillion]) {
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > 10000) fail('VALIDATION', 'Explicit model rates must be positive and bounded.');
    }
    configuredRates.set(model, { input: Math.ceil(rate.inputUSDPerMillion * 1000), output: Math.ceil(rate.outputUSDPerMillion * 1000) });
  }
  const now = () => {
    const time = clock();
    if (typeof time !== 'number' || !Number.isFinite(time) || !Number.isFinite(new Date(time).getTime())) fail('VALIDATION', 'Clock returned an invalid timestamp.');
    return new Date(time).toISOString();
  };
  now();
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  let closed = false;
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
    const version=one('PRAGMA user_version').user_version;
    if (version > 2) fail('VALIDATION', 'Unsupported AI ledger schema.');
    db.exec('BEGIN IMMEDIATE');
    db.exec("CREATE TABLE IF NOT EXISTS ai_requests(request_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,model TEXT NOT NULL,month TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('reserved','completed','uncertain','rejected')),reservation_token TEXT NOT NULL,input_rate INTEGER NOT NULL,output_rate INTEGER NOT NULL,input_upper INTEGER NOT NULL,output_upper INTEGER NOT NULL,reserved_nanos INTEGER NOT NULL,reserved_tokens INTEGER NOT NULL,charged_nanos INTEGER NOT NULL DEFAULT 0,input_tokens INTEGER,output_tokens INTEGER,result_json TEXT,error_code TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE INDEX IF NOT EXISTS ai_request_month ON ai_requests(month);");
    const columns=new Set(db.prepare('PRAGMA table_info(ai_requests)').all().map(column=>column.name));
    if(!columns.has('retry_count'))db.exec('ALTER TABLE ai_requests ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0');
    if(!columns.has('retry_authorized'))db.exec('ALTER TABLE ai_requests ADD COLUMN retry_authorized INTEGER NOT NULL DEFAULT 0');
    // Publish the version with the whole migration, and avoid a redundant write
    // on unchanged warm opens while retaining all schema/column checks.
    if(version!==2)db.exec('PRAGMA user_version=2');
    db.exec('COMMIT');
  } catch (error) { try{db.exec('ROLLBACK');}catch{} db.close(); throw error; }
  const assertOpen = () => { if (closed) fail('CLOSED', 'AI ledger is closed.'); };
  const transaction = callback => {
    assertOpen(); db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const rowFor = id => {
    string(id, 100); const row = one('SELECT * FROM ai_requests WHERE request_id=?', id);
    if (!row) fail('NOT_FOUND', 'AI request was not found.');
    return row;
  };
  const retryable=row=>row.state==='rejected'&&row.retry_count<2&&row.charged_nanos===0&&RELEASE_CODES.has(row.error_code)&&row.input_tokens===null&&row.output_tokens===null;
  const publicRow = (row, dispatch = false) => ({
    requestId: row.request_id, state: row.state, dispatch, replay: row.state === 'completed',retryable:retryable(row),retryCount:row.retry_count,
    ...(dispatch ? { reservationToken: row.reservation_token } : {}),
    model: row.model, month: row.month,
    reservedUSD: row.reserved_nanos / NANO_USD, reservedTokens: row.reserved_tokens,
    chargedUSD: row.charged_nanos / NANO_USD,
    ...(row.result_json === null ? {} : { result: JSON.parse(row.result_json) }),
    ...(row.error_code === null ? {} : { code: row.error_code })
  });
  const monthly = month => one("SELECT COALESCE(SUM(charged_nanos),0) AS spent,COALESCE(SUM(CASE WHEN state IN ('reserved','uncertain') THEN reserved_nanos ELSE 0 END),0) AS held,COALESCE(SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)),0) AS spent_tokens,COALESCE(SUM(CASE WHEN state IN ('reserved','uncertain') THEN reserved_tokens ELSE 0 END),0) AS held_tokens,SUM(CASE WHEN state='reserved' THEN 1 ELSE 0 END) AS reserved,SUM(CASE WHEN state='uncertain' THEN 1 ELSE 0 END) AS uncertain,SUM(CASE WHEN state='completed' THEN 1 ELSE 0 END) AS completed,SUM(CASE WHEN state='rejected' THEN 1 ELSE 0 END) AS rejected FROM ai_requests WHERE month=?", month);
  const checkToken = (row, token) => { if (typeof token !== 'string' || token !== row.reservation_token) fail('RESERVATION_CONFLICT', 'AI reservation ownership does not match.'); };
  const codeValue = value => {
    const code = value ?? 'UNKNOWN';
    if (typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(code)) fail('VALIDATION', 'Only a safe error code may be persisted.');
    return code;
  };
  return Object.freeze({
    reserve(input) {
      fields(input, ['requestId', 'request']);
      if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.requestId)) fail('VALIDATION', 'Invalid request identity.');
      const request = requestValue(input.request);
      const hash = createHash('sha256').update(canonical(request)).digest('hex');
      return transaction(() => {
        const prior = one('SELECT * FROM ai_requests WHERE request_id=?', input.requestId);
        if (prior) {
          if (prior.request_hash !== hash) fail('REQUEST_CONFLICT', 'Request identity was already used for different content.');
          if(!retryable(prior)||prior.retry_authorized!==1)return publicRow(prior); // Only an explicit proven-safe retry can dispatch again.
        }
        const rate = configuredRates.get(request.model);
        if (!rate) fail('AI_RATE_UNKNOWN', 'Explicit model pricing is required before dispatch.');
        const time = now(), month = time.slice(0, 7);
        // UTF-8 bytes upper-bound text tokens conservatively; schema/instructions plus framing are included.
        const upperInput = Buffer.byteLength(JSON.stringify(request), 'utf8') + INPUT_OVERHEAD_TOKENS;
        const upperOutput = request.max_output_tokens, reservedTokens = upperInput + upperOutput;
        const reservedNanos = safeCost(upperInput, upperOutput, rate.input, rate.output), totals = monthly(month);
        if (totals.spent + totals.held + reservedNanos > limitNanos || totals.spent_tokens + totals.held_tokens + reservedTokens > monthlyTokens) fail('AI_BUDGET_EXCEEDED', 'The monthly AI budget is already spent or reserved.');
        if(prior){
          run("UPDATE ai_requests SET state='reserved',reservation_token=?,month=?,input_rate=?,output_rate=?,input_upper=?,output_upper=?,reserved_nanos=?,reserved_tokens=?,retry_authorized=0,retry_count=retry_count+1,error_code=NULL,updated_at=? WHERE request_id=?",randomUUID(),month,rate.input,rate.output,upperInput,upperOutput,reservedNanos,reservedTokens,time,input.requestId);
          return publicRow(rowFor(input.requestId),true);
        }
        run("INSERT INTO ai_requests(request_id,request_hash,model,month,state,reservation_token,input_rate,output_rate,input_upper,output_upper,reserved_nanos,reserved_tokens,created_at,updated_at) VALUES(?,?,?,?,'reserved',?,?,?,?,?,?,?,?,?)",
          input.requestId, hash, request.model, month, randomUUID(), rate.input, rate.output, upperInput, upperOutput, reservedNanos, reservedTokens, time, time);
        return publicRow(rowFor(input.requestId), true);
      });
    },
    complete(id, token, input) {
      fields(input, ['result', 'usage']);
      const result = jsonValue(input.result), usage = usageValue(input.usage);
      return transaction(() => {
        const row = rowFor(id); checkToken(row, token);
        if (row.state === 'completed') {
          if (canonical(JSON.parse(row.result_json)) !== canonical(result) || row.input_tokens !== usage.input_tokens || row.output_tokens !== usage.output_tokens) fail('REQUEST_CONFLICT', 'Completed request cannot be rewritten.');
          return publicRow(row);
        }
        if (!['reserved', 'uncertain'].includes(row.state)) fail('RESERVATION_CONFLICT', 'AI request is already terminal.');
        const cost = safeCost(usage.input_tokens, usage.output_tokens, row.input_rate, row.output_rate);
        // Record actual usage even if the provider exceeded the estimate; never conceal incurred cost.
        run("UPDATE ai_requests SET state='completed',charged_nanos=?,input_tokens=?,output_tokens=?,result_json=?,error_code=NULL,updated_at=? WHERE request_id=?", cost, usage.input_tokens, usage.output_tokens, JSON.stringify(result), now(), id);
        return publicRow(rowFor(id));
      });
    },
    uncertain(id, token, input = {}) {
      fields(input, ['code']); const code = codeValue(input.code);
      return transaction(() => {
        const row = rowFor(id); checkToken(row, token);
        if (row.state === 'completed') return publicRow(row);
        if (row.state === 'rejected') fail('RESERVATION_CONFLICT', 'A definitive rejection cannot become uncertain.');
        run("UPDATE ai_requests SET state='uncertain',error_code=?,updated_at=? WHERE request_id=?", code, now(), id);
        return publicRow(rowFor(id));
      });
    },
    reject(id, token, input) {
      fields(input, ['code', 'usage']); const code = codeValue(input.code);
      const usage = input.usage === undefined ? null : usageValue(input.usage);
      if (usage === null && !RELEASE_CODES.has(code)) fail('VALIDATION', 'Only a definitive rejection or pre-dispatch cancellation can release an unmeasured reservation.');
      return transaction(() => {
        const row = rowFor(id); checkToken(row, token);
        if (row.state === 'completed') fail('RESERVATION_CONFLICT', 'A completed request cannot be rejected.');
        const cost = usage === null ? 0 : safeCost(usage.input_tokens, usage.output_tokens, row.input_rate, row.output_rate);
        if (row.state === 'rejected') {
          if (row.error_code !== code || row.charged_nanos !== cost || row.input_tokens !== (usage?.input_tokens ?? null) || row.output_tokens !== (usage?.output_tokens ?? null)) fail('REQUEST_CONFLICT', 'Definitive rejection cannot be rewritten.');
          return publicRow(row);
        }
        run("UPDATE ai_requests SET state='rejected',charged_nanos=?,input_tokens=?,output_tokens=?,error_code=?,updated_at=? WHERE request_id=?", cost, usage?.input_tokens ?? null, usage?.output_tokens ?? null, code, now(), id);
        return publicRow(rowFor(id));
      });
    },
    getRequest(id){assertOpen();string(id,100);const row=one('SELECT * FROM ai_requests WHERE request_id=?',id);return row?publicRow(row):null;},
    authorizeRetry(id){return transaction(()=>{const row=rowFor(id);if(!retryable(row))fail('AI_RETRY_FORBIDDEN','This request has no safe unpaid retry remaining.');run('UPDATE ai_requests SET retry_authorized=1,updated_at=? WHERE request_id=?',now(),id);return publicRow(rowFor(id));});},
    status() {
      assertOpen();
      const month = now().slice(0, 7), totals = monthly(month), used = totals.spent + totals.held, tokens = totals.spent_tokens + totals.held_tokens;
      return {
        month, limits: { usd: limitNanos / NANO_USD, tokens: monthlyTokens },
        spentUSD: totals.spent / NANO_USD, reservedUSD: totals.held / NANO_USD, usedUSD: used / NANO_USD, remainingUSD: Math.max(0, limitNanos - used) / NANO_USD,
        spentTokens: totals.spent_tokens, reservedTokens: totals.held_tokens, usedTokens: tokens, remainingTokens: Math.max(0, monthlyTokens - tokens),
        overBudget: used > limitNanos || tokens > monthlyTokens,
        counts: { reserved: totals.reserved ?? 0, uncertain: totals.uncertain ?? 0, completed: totals.completed ?? 0, rejected: totals.rejected ?? 0 }
      };
    },
    close() { if (!closed) { db.close(); closed = true; } }
  });
}
