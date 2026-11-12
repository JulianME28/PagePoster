import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createSecretBox } from './secrets.mjs';
import {unpackSiteCredential,encryptSiteCredential} from './browser-credential-envelope.mjs';
import { normalizeSiteCriteria } from './site-source.mjs';
import {failedPublishedDiagnostics,publishedDiagnosticMessage} from './published-diagnostics.mjs';

const JOB_TYPES = Object.freeze({ site_check: 'read', page_check: 'read', publish:'write', replace:'write', adopt:'write' });
const CHECK_STATES = new Set(['ok', 'problem', 'unknown', 'not_applicable']);
const PROJECT_FIELDS = ['name', 'description', 'language', 'country', 'tags', 'responsible', 'archived', 'trashed', 'monitoringPolicy', 'siteSelection', 'workflowType'];
export const DEFAULT_MONITORING_POLICY=Object.freeze({enabled:true,pageIntervalMinutes:360,siteIntervalMinutes:1440,retryMinutes:5,retentionDays:30});
const SITE_FIELDS = ['name', 'baseUrl', 'enabled', 'status', 'capabilities', 'lastCheckedAt', 'plugins', 'bootstrap', 'username', 'applicationPassword'];
const PAGE_FIELDS = ['siteId', 'title', 'keyword', 'config', 'fullUrl', 'wpId', 'wpType', 'expectedUrls', 'expectedMarker', 'lifecycleState', 'remoteSnapshot'];
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function object(value, label = 'Input') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('VALIDATION', label + ' must be an object.');
  return value;
}
function fields(value, allowed) {
  object(value);
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('VALIDATION', 'Unknown input field.');
  return value;
}
function text(value, label, max = 1000, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail('VALIDATION', label + ' is invalid.');
  return value;
}
function json(value, max = 3000000) {
  let count = 0;
  const visit = (item, depth) => {
    if (++count > 100000 || depth > 80) fail('VALIDATION', 'JSON is too complex.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (Array.isArray(item)) { for (const child of item) visit(child, depth + 1); return; }
    object(item, 'JSON');
    for (const child of Object.values(item)) visit(child, depth + 1);
  };
  try { visit(value, 0); } catch (error) {
    if (error.code === 'VALIDATION') throw error;
    fail('VALIDATION', 'Input must contain JSON values only.');
  }
  const encoded = JSON.stringify(value);
  if (encoded.length > max) fail('VALIDATION', 'JSON is too large.');
  return JSON.parse(encoded);
}
function url(value, label, optional = false) {
  text(value, label, 10000);
  if (optional && value === '') return value;
  if (value !== value.trim() || /[\u0000-\u0020\u007f]/.test(value)) fail('VALIDATION', label + ' must be an HTTP(S) URL.');
  let parsed;
  try { parsed = new URL(value); } catch { fail('VALIDATION', label + ' must be an HTTP(S) URL.'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) fail('VALIDATION', label + ' must be an HTTP(S) URL without credentials.');
  return value; // Validation deliberately does not normalize tracking URLs.
}
function timestamp(value, label = 'Timestamp') {
  const milliseconds = typeof value === 'number' ? value : (typeof value === 'string' ? Date.parse(value) : NaN);
  if (!Number.isFinite(milliseconds) || !Number.isFinite(new Date(milliseconds).getTime())) fail('VALIDATION', label + ' is invalid.');
  return new Date(milliseconds).toISOString();
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function projectData(input, previous) {
  fields(input, PROJECT_FIELDS);
  const value = { name: '', description: '', language: '', country: '', tags: [], responsible:'', archived:false, ...previous, ...input };
  if(value.trashed!==undefined&&typeof value.trashed!=='boolean'||value.trashed&&!value.archived)fail('VALIDATION','Invalid project trash state.');
  if(value.workflowType!==undefined&&value.workflowType!==null&&!['ai','html'].includes(value.workflowType))fail('VALIDATION','Invalid project type.');
  if(previous?.workflowType&&value.workflowType!==previous.workflowType)fail('CONFLICT','Project source type is fixed.');
  if(own(input,'siteSelection'))fields(input.siteSelection,['minDr','minTraffic','geo']);
  try{value.siteSelection=normalizeSiteCriteria(input.siteSelection===undefined?previous?.siteSelection:input.siteSelection);}catch{fail('VALIDATION','Invalid site selection criteria.');}
  value.monitoringPolicy={...DEFAULT_MONITORING_POLICY,...previous?.monitoringPolicy,...input.monitoringPolicy};
  fields(value.monitoringPolicy,Object.keys(DEFAULT_MONITORING_POLICY));
  if(typeof value.archived!=='boolean'||typeof value.monitoringPolicy.enabled!=='boolean')fail('VALIDATION','Invalid project policy.');
  text(value.responsible,'Responsible person',300);
  for(const [key,min,max] of [['pageIntervalMinutes',15,10080],['siteIntervalMinutes',60,43200],['retryMinutes',1,60],['retentionDays',1,365]])if(!Number.isSafeInteger(value.monitoringPolicy[key])||value.monitoringPolicy[key]<min||value.monitoringPolicy[key]>max)fail('VALIDATION','Invalid monitoring interval.');
  text(value.name, 'Project name', 300, true); text(value.description, 'Description', 20000);
  text(value.language, 'Language', 100); text(value.country, 'Country', 100);
  if (!Array.isArray(value.tags) || value.tags.length > 100) fail('VALIDATION', 'Tags must be an array of at most 100 strings.');
  value.tags.forEach(tag => text(tag, 'Tag', 100));
  return value;
}
function siteData(input, previous) {
  fields(input, SITE_FIELDS);
  const clean = { ...input }; delete clean.username; delete clean.applicationPassword;
  const value = { name: '', baseUrl: '', enabled: true, status: 'unknown', capabilities: {}, plugins:{},bootstrap:{},lastCheckedAt: null, ...previous, ...clean };
  text(value.name, 'Site name', 300, true); url(value.baseUrl, 'Base URL');
  if (typeof value.enabled !== 'boolean') fail('VALIDATION', 'Enabled must be a boolean.');
  text(value.status, 'Site status', 100); object(value.capabilities, 'Capabilities'); value.capabilities = json(value.capabilities, 100000);
  value.plugins=json(value.plugins,100000);value.bootstrap=json(value.bootstrap,100000);
  if (value.lastCheckedAt !== null) value.lastCheckedAt = timestamp(value.lastCheckedAt);
  const parsed = new URL(value.baseUrl);
  value.allowedOrigin = parsed.origin; value.installationPath = parsed.pathname;
  return value;
}
function pageData(input, previous) {
  fields(input, PAGE_FIELDS);
  const value = { siteId: null, title: '', keyword: '', config: {}, fullUrl: '', wpId: null, wpType: 'page', expectedUrls: [], expectedMarker: '', lifecycleState: 'draft', remoteSnapshot:null, ...previous, ...input };
  text(value.title, 'Page title', 1000, true); text(value.keyword, 'Keyword', 2000);
  url(value.fullUrl, 'Page URL', true); value.config = json(value.config);
  if (value.siteId !== null) text(value.siteId, 'Site ID', 200, true);
  if (value.wpId !== null && (!Number.isSafeInteger(value.wpId) || value.wpId < 1)) fail('VALIDATION', 'WordPress ID must be a positive integer.');
  if (!['page', 'post'].includes(value.wpType)) fail('VALIDATION', 'WordPress type must be page or post.');
  if (!Array.isArray(value.expectedUrls) || value.expectedUrls.length > 1000) fail('VALIDATION', 'Expected URLs must be an array.');
  value.expectedUrls.forEach(value => url(value, 'Expected URL'));
  text(value.expectedMarker, 'Expected marker', 1000); text(value.lifecycleState, 'Page state', 100);
  if(value.remoteSnapshot!==null)value.remoteSnapshot=json(value.remoteSnapshot);
  return value;
}

/** Local single-owner storage. Network authorization and SSRF checks belong to the server adapter. */
export function createStore({ filename, masterKey, clock = Date.now } = {}) {
  text(filename, 'Database filename', 32000, true);
  if (typeof clock !== 'function') fail('VALIDATION', 'Clock must be a function.');
  const secretBox = masterKey ? createSecretBox(masterKey) : null;
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  let closed = false;
  const now = () => timestamp(clock());
  let readCache=null;
  const run = (sql, ...args) => {if(readCache)fail('READ_ONLY_SNAPSHOT','Writes are forbidden during a read snapshot.');return db.prepare(sql).run(...args);};
  const query=(mode,sql,args)=>{if(!readCache)return db.prepare(sql)[mode](...args);const key=mode+sql+JSON.stringify(args);if(!readCache.queries.has(key))readCache.queries.set(key,db.prepare(sql)[mode](...args));return readCache.queries.get(key);};
  const one = (sql, ...args) => query('get',sql,args);
  const all = (sql, ...args) => query('all',sql,args);
  let transactionDepth=0;
  const transaction = callback => {
    if (closed) fail('CLOSED', 'Store is closed.');
    if(readCache)fail('READ_ONLY_SNAPSHOT','Writes are forbidden during a read snapshot.');
    const level=transactionDepth++, savepoint='pageposter_'+level;
    db.exec(level?'SAVEPOINT '+savepoint:'BEGIN IMMEDIATE');
    try { const result=callback(); db.exec(level?'RELEASE '+savepoint:'COMMIT'); return result; }
    catch(error){db.exec(level?'ROLLBACK TO '+savepoint:'ROLLBACK');if(level)db.exec('RELEASE '+savepoint);throw error;}
    finally{transactionDepth--;}
  };
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
    const version = one('PRAGMA user_version').user_version;
    if (version > 6) fail('VALIDATION', 'Database schema is newer than this application.');
    db.exec('BEGIN IMMEDIATE');
    db.exec(
      'CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,data TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS sites(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),enabled INTEGER NOT NULL,data TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS site_credentials(site_id TEXT PRIMARY KEY REFERENCES sites(id),envelope TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS pages(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),site_id TEXT REFERENCES sites(id),data TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS page_versions(id TEXT PRIMARY KEY,page_id TEXT NOT NULL REFERENCES pages(id),revision INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(page_id,revision));' +
      'CREATE TABLE IF NOT EXISTS checks(id TEXT PRIMARY KEY,page_id TEXT NOT NULL REFERENCES pages(id),project_id TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL);' +
      "CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),site_id TEXT REFERENCES sites(id),page_id TEXT REFERENCES pages(id),type TEXT NOT NULL,effect TEXT NOT NULL CHECK(effect IN ('read','write')),state TEXT NOT NULL CHECK(state IN ('queued','running','completed','failed','paused','uncertain')),attempt INTEGER NOT NULL DEFAULT 0,idempotency_key TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,payload_json TEXT NOT NULL,run_after INTEGER NOT NULL,worker_id TEXT,lease_token TEXT,lease_until INTEGER,result_json TEXT,error_json TEXT,revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);" +
      "CREATE UNIQUE INDEX IF NOT EXISTS one_running_job_per_site ON jobs(site_id) WHERE state='running' AND site_id IS NOT NULL;" +
      'CREATE INDEX IF NOT EXISTS due_jobs ON jobs(state,run_after);' +
      'CREATE INDEX IF NOT EXISTS project_sites ON sites(project_id);' +
      'CREATE INDEX IF NOT EXISTS project_pages ON pages(project_id);' +
      'CREATE INDEX IF NOT EXISTS page_checks ON checks(page_id);' +
      'CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY,page_id TEXT NOT NULL REFERENCES pages(id),data TEXT NOT NULL);'+
      'CREATE TABLE IF NOT EXISTS generation_receipts(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,data TEXT NOT NULL);'+
      'CREATE TABLE IF NOT EXISTS campaigns(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),idempotency_key TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,data TEXT NOT NULL);'+
      'CREATE INDEX IF NOT EXISTS project_campaigns ON campaigns(project_id);'+
      'CREATE TABLE IF NOT EXISTS project_site_links(project_id TEXT NOT NULL REFERENCES projects(id),site_id TEXT NOT NULL REFERENCES sites(id),PRIMARY KEY(project_id,site_id));'+
      'INSERT OR IGNORE INTO project_site_links(project_id,site_id) SELECT project_id,id FROM sites;'+
      'CREATE TABLE IF NOT EXISTS workspace_records(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),kind TEXT NOT NULL,data TEXT NOT NULL);'+
      'CREATE INDEX IF NOT EXISTS project_records ON workspace_records(project_id,kind);'+
      // Private workspace policy outlives projects and their history retention.
      'CREATE TABLE IF NOT EXISTS workspace_policy_records(id TEXT PRIMARY KEY,kind TEXT NOT NULL,data TEXT NOT NULL);'+
      'CREATE INDEX IF NOT EXISTS workspace_policies ON workspace_policy_records(kind);'+
      'CREATE TABLE IF NOT EXISTS generation_fingerprints(fingerprint TEXT PRIMARY KEY,page_id TEXT NOT NULL REFERENCES pages(id),run_id TEXT NOT NULL);'+
      'PRAGMA user_version=6; COMMIT;'
    );
  } catch (error) { db.close(); throw error; }

  const decoded = row => {if(!row)return null;if(!readCache)return JSON.parse(row.data);if(!readCache.decoded.has(row.data))readCache.decoded.set(row.data,JSON.parse(row.data));return readCache.decoded.get(row.data);};
  const read = (table, id) => decoded(one('SELECT data FROM ' + table + ' WHERE id=?', id));
  const requireRecord = (table, id) => {
    text(id, 'Record ID', 200, true);
    const record = read(table, id); if (!record) fail('NOT_FOUND', 'Record was not found.'); return record;
  };
  const requireProject = id => requireRecord('projects', id);
  const relatedSite = (projectId, siteId) => {
    if (siteId === null) return null;
    const site = requireRecord('sites', siteId);
    if (!one('SELECT 1 FROM project_site_links WHERE project_id=? AND site_id=?',projectId,siteId)) fail('VALIDATION', 'Site is not linked to this project.');
    return site;
  };
  const revision = (current, expected) => {
    if (!Number.isSafeInteger(expected) || expected < 1) fail('VALIDATION', 'Expected revision is required.');
    if (current.revision !== expected) fail('CONFLICT', 'The record has changed. Reload it before updating.');
  };
  const base = projectId => {
    const time = now();
    return { id: randomUUID(), ...(projectId ? { projectId } : {}), revision: 1, createdAt: time, updatedAt: time };
  };
  const saveDocument = (table, value) => run('UPDATE ' + table + ' SET data=? WHERE id=?', JSON.stringify(value), value.id);
  const storedCredential = (siteId,site=read('sites',siteId)) => {const row=one('SELECT envelope FROM site_credentials WHERE site_id=?',siteId);return row?unpackSiteCredential(siteId,JSON.parse(row.envelope),site):null;};
  const publicSite = value => {if(!value)return null;const credential=storedCredential(value.id,value),browser=credential?.kind==='browser-login';return {...value,hasCredential:!!credential&&!browser,...(browser?{hasBrowserCredential:true}:{})};};
  const credentialInput = input => {
    object(input);
    if (!own(input, 'username') && !own(input, 'applicationPassword')) return undefined;
    if (!own(input, 'username') || !own(input, 'applicationPassword')) fail('VALIDATION', 'Both credential fields must be supplied together.');
    text(input.username, 'Username', 1000); text(input.applicationPassword, 'Application password', 4096);
    if (input.username === '' && input.applicationPassword === '') return null;
    if (!input.username || !input.applicationPassword) fail('VALIDATION', 'Both credential fields must be nonempty.');
    return { username: input.username, applicationPassword: input.applicationPassword };
  };
  const saveCredentials = (siteId, credentials, preserveBrowser=false) => {
    const prior=storedCredential(siteId),browser=preserveBrowser||prior?.kind==='browser-login'||read('sites',siteId)?.bootstrap?.mode==='browser';
    if (credentials === undefined&&(!browser||!prior||prior.wrapped)) return;
    if (credentials === null) { run('DELETE FROM site_credentials WHERE site_id=?', siteId); return; }
    if (!secretBox) fail('KEY_REQUIRED', 'Credential encryption is not configured.');
    if(credentials===undefined)credentials=secretBox.decrypt(prior.aad,prior.envelope);
    const envelope = encryptSiteCredential(secretBox,siteId,credentials,browser);
    run('INSERT INTO site_credentials(site_id,envelope) VALUES(?,?) ON CONFLICT(site_id) DO UPDATE SET envelope=excluded.envelope', siteId, JSON.stringify(envelope));
  };
  const pageSnapshot = page => {
    const entry = { id: randomUUID(), projectId: page.projectId, pageId: page.id, revision: page.revision, createdAt: page.updatedAt, updatedAt: page.updatedAt, snapshot: page };
    run('INSERT INTO page_versions(id,page_id,revision,data) VALUES(?,?,?,?)', entry.id, page.id, page.revision, JSON.stringify(entry));
  };
  const pageVerification=page=>{
    const value=decoded(one("SELECT data FROM workspace_records WHERE kind='verification' AND id=?",'verification:'+page.id))?.summary;
    if(!value||value.checkedRevision!==page.revision||value.contentHash!==(page.remoteSnapshot?.contentHash||null))return {state:'pending',checkedAt:null,summary:'Поточна версія ще не перевірена.'};
    const project=read('projects',page.projectId),interval=project?.monitoringPolicy?.pageIntervalMinutes||DEFAULT_MONITORING_POLICY.pageIntervalMinutes;
    if(Date.parse(value.checkedAt)<clock()-interval*120000)return {...value,state:'unknown',stale:true,summary:'Результат перевірки застарів. Запусти нову перевірку.'};
    return value;
  };
  const publicPage = page => page ? { ...page,verification:pageVerification(page), versions: all('SELECT data FROM page_versions WHERE page_id=? ORDER BY revision', page.id).map(decoded) } : null;
  const publicJob = row => row ? {
    id: row.id, operationId: row.id, projectId: row.project_id, siteId: row.site_id, pageId: row.page_id,
    type: row.type, effect: row.effect, state: row.state, attempt: row.attempt,retryable:row.state==='uncertain'&&row.attempt<3&&!!(row.result_json&&JSON.parse(row.result_json).recovery?.canRetry),
    idempotencyKey: row.idempotency_key, payload: JSON.parse(row.payload_json), runAfter: timestamp(row.run_after),
    leaseUntil: row.lease_until === null ? null : timestamp(row.lease_until),
    result: row.result_json === null ? null : JSON.parse(row.result_json),
    error: row.error_json === null ? null : JSON.parse(row.error_json),
    revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at
  } : null;
  const jobRow = id => { const row = one('SELECT * FROM jobs WHERE id=?', id); if (!row) fail('NOT_FOUND', 'Job was not found.'); return row; };
  const recover = time => {
    const rows = all("SELECT * FROM jobs WHERE state='running' AND lease_until<=? ORDER BY created_at,rowid", Date.parse(time));
    return rows.map(row => {
      const state = row.effect === 'write' ? 'uncertain' : row.attempt < 3 ? 'queued' : 'failed';
      const error = state === 'uncertain' ? { code: 'LEASE_EXPIRED_UNCERTAIN' } : state === 'failed' ? { code: 'MAX_ATTEMPTS' } : null;
      run('UPDATE jobs SET state=?,run_after=?,worker_id=NULL,lease_token=NULL,lease_until=NULL,error_json=?,revision=revision+1,updated_at=? WHERE id=?',
        state, Date.parse(time), error ? JSON.stringify(error) : null, time, row.id);
      return publicJob(jobRow(row.id));
    });
  };
  const secretValues = () => {
    const values = new Set([masterKey]);
    for (const row of all('SELECT site_id,envelope FROM site_credentials')) {
      if (!secretBox) fail('KEY_REQUIRED', 'Credential encryption is not configured.');
      // Redaction uses only envelope/AAD. Both legacy kinds use siteId AAD;
      // typed browser wrappers supply their own kind and browser-specific AAD.
      const envelope=unpackSiteCredential(row.site_id,JSON.parse(row.envelope));
      const credentials = secretBox.decrypt(envelope.aad,envelope.envelope);
      values.add(credentials.applicationPassword);
      values.add(Buffer.from(credentials.username + ':' + credentials.applicationPassword).toString('base64'));
    }
    return [...values].filter(Boolean).sort((a, b) => b.length - a.length);
  };
  const scrub = (value, secrets) => {
    if (typeof value === 'string') { for (const secret of secrets) value = value.split(secret).join('[REDACTED]'); return value; }
    if (Array.isArray(value)) return value.map(item => scrub(item, secrets));
    if (value && typeof value === 'object') {
      const result = {};
      for (const [key, child] of Object.entries(value)) {
        if (/password|credential|username|authorization|cookie|secret|apikey|masterkey|accesstoken|refreshtoken|leasetoken|ciphertext/i.test(key.replace(/[-_ ]/g, ''))) continue;
        Object.defineProperty(result, key, { value: scrub(child, secrets), enumerable: true, writable: true, configurable: true });
      }
      return result;
    }
    return value;
  };
  const safeMetadata = value => scrub(json(value, 500000), secretValues());
  const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));
  const policyKind = kind => {if(kind!=='donor_exclusion')fail('VALIDATION','Invalid workspace policy kind.');};
  const policyPayload = input => {
    object(input);
    if(Object.keys(input).some(key=>['id','projectId','kind','revision','createdAt','updatedAt'].includes(key)))fail('VALIDATION','Reserved record field.');
    return json(input,16000000);
  };


  const backupMetadata = ['id', 'projectId', 'revision', 'createdAt', 'updatedAt'];
  const assertBackupSafe = backup => {
    const secrets = secretValues();
    const credentialKey = /^(?:password|applicationpassword|username|authorization|cookie|secret|apikey|masterkey|accesstoken|refreshtoken|leasetoken|ciphertext|credentials?)$/i;
    const visit = value => {
      if (typeof value === 'string') {
        if (secrets.some(secret => value.includes(secret))) fail('BACKUP_SECRET', 'Authored content contains credential material; backup was not exported or restored.');
      } else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          if (secrets.some(secret => key.includes(secret)) || credentialKey.test(key.replace(/[-_ ]/g, ''))) fail('BACKUP_SECRET', 'Backup contains a credential field; no content was rewritten.');
          visit(child);
        }
      }
    };
    visit(backup);
  };
  const validatedBackup = input => {
    const value = json(input, 50000000);
    const collections = ['projects', 'sites', 'pages', 'pageVersions', 'checks', 'events', 'jobs'];
    fields(value, ['kind', 'schemaVersion', 'exportedAt', 'siteLinks', ...collections]);
    if (value.kind !== 'pageposter-lifecycle-backup' || ![1,2].includes(value.schemaVersion)) fail('VALIDATION', 'Unsupported backup format.');
    const date = item => { if (typeof item !== 'string' || timestamp(item) !== item) fail('VALIDATION', 'Backup timestamp must be an ISO timestamp.'); };
    date(value.exportedAt);
    for (const key of collections) {
      if (!Array.isArray(value[key]) || value[key].length > 20000) fail('VALIDATION', 'Invalid backup collection.');
    }
    const ids = new Set();
    const meta = (item, project = true, register = true) => {
      object(item); text(item.id, 'Backup identity', 200, true);
      if (register) { if (ids.has(item.id)) fail('VALIDATION', 'Duplicate backup identity.'); ids.add(item.id); }
      if (project) text(item.projectId, 'Backup project identity', 200, true);
      if (!Number.isSafeInteger(item.revision) || item.revision < 1) fail('VALIDATION', 'Invalid backup revision.');
      date(item.createdAt); date(item.updatedAt);
      if (item.updatedAt < item.createdAt) fail('VALIDATION', 'Backup timestamp order is invalid.');
    };
    const subset = (item, keys) => Object.fromEntries(keys.filter(key => own(item, key)).map(key => [key, item[key]]));
    const projects = new Map(), sites = new Map(), pages = new Map();
    if(value.siteLinks!==undefined&&(!Array.isArray(value.siteLinks)||value.siteLinks.length>20000))fail('VALIDATION','Invalid site links.');
    const projectRef = item => { if (!projects.has(item.projectId)) fail('VALIDATION', 'Backup project reference is missing.'); };
    const siteRef = (projectId, siteId) => {
      if (siteId === null) return;
      if (!sites.has(siteId) || (sites.get(siteId).projectId !== projectId && !(value.siteLinks||[]).some(l=>l.projectId===projectId&&l.siteId===siteId))) fail('VALIDATION', 'Backup site reference is invalid.');
    };
    const pageRef = item => {
      const page = pages.get(item.pageId);
      if (!page || page.projectId !== item.projectId) fail('VALIDATION', 'Backup page reference is invalid.');
      return page;
    };
    for (const item of value.projects) {
      fields(item, ['id', 'revision', 'createdAt', 'updatedAt', ...PROJECT_FIELDS]); meta(item, false);
      projectData(subset(item, PROJECT_FIELDS)); projects.set(item.id, item);
    }
    for (const item of value.sites) {
      fields(item, [...backupMetadata, ...SITE_FIELDS.filter(key => !['username', 'applicationPassword'].includes(key)), 'allowedOrigin', 'installationPath', 'hasCredential']);
      meta(item); projectRef(item);
      const checked = siteData(subset(item, SITE_FIELDS));
      if (item.allowedOrigin !== checked.allowedOrigin || item.installationPath !== checked.installationPath || (own(item, 'hasCredential') && typeof item.hasCredential !== 'boolean')) fail('VALIDATION', 'Backup site settings are inconsistent.');
      sites.set(item.id, item);
    }
    for(const link of value.siteLinks||[]){fields(link,['projectId','siteId']);if(!projects.has(link.projectId)||!sites.has(link.siteId))fail('VALIDATION','Invalid site link.');}
    const validatePage = item => {
      fields(item, [...backupMetadata, ...PAGE_FIELDS]); meta(item, true, false); projectRef(item);
      pageData(subset(item, PAGE_FIELDS)); siteRef(item.projectId, item.siteId);
    };
    for (const item of value.pages) { meta(item); validatePage(item); pages.set(item.id, item); }
    const versions = new Map();
    for (const item of value.pageVersions) {
      fields(item, [...backupMetadata, 'pageId', 'snapshot']); meta(item);
      const page = pageRef(item); validatePage(item.snapshot);
      if (item.snapshot.id !== page.id || item.snapshot.projectId !== page.projectId || item.snapshot.revision !== item.revision || item.revision > page.revision || item.createdAt !== item.snapshot.updatedAt || item.updatedAt !== item.createdAt) fail('VALIDATION', 'Backup snapshot identity is inconsistent.');
      const history = versions.get(page.id) ?? new Map();
      if (history.has(item.revision)) fail('VALIDATION', 'Duplicate page version.');
      history.set(item.revision, item.snapshot); versions.set(page.id, history);
    }
    for (const page of value.pages) {
      const history = versions.get(page.id);
      if (!history || history.size !== page.revision || canonical(history.get(page.revision)) !== canonical(page)) fail('VALIDATION', 'Backup page history is incomplete.');
    }
    for (const item of value.checks) {
      fields(item, [...backupMetadata, 'pageId', 'kind', 'state', 'checkedAt']); meta(item); pageRef(item);
      text(item.kind, 'Check kind', 100, true);
      if (!CHECK_STATES.has(item.state)) fail('VALIDATION', 'Invalid backup check state.');
      date(item.checkedAt);
    }
    for (const item of value.events) {
      fields(item, [...backupMetadata, 'type', 'entityId']); meta(item); projectRef(item);
      text(item.type, 'Event type', 100, true); text(item.entityId, 'Historic entity identity', 200, true);
    }
    for (const item of value.jobs) {
      fields(item, [...backupMetadata, 'siteId', 'pageId', 'operationId', 'type', 'effect', 'state', 'attempt', 'runAfter']);
      meta(item); projectRef(item); siteRef(item.projectId, item.siteId);
      if (item.pageId !== null) pageRef(item); // A historical job may precede a later page-to-site reassignment.
      if (item.operationId !== item.id || !own(JOB_TYPES, item.type) || item.effect !== JOB_TYPES[item.type] || !['queued', 'running', 'completed', 'failed', 'paused', 'uncertain'].includes(item.state) || !Number.isSafeInteger(item.attempt) || item.attempt < 0 || item.attempt > 3) fail('VALIDATION', 'Invalid backup job metadata.');
      if ((item.type === 'site_check' && (item.siteId === null || item.pageId !== null)) || (item.type !== 'site_check' && item.pageId === null)) fail('VALIDATION', 'Invalid backup job relationships.');
      date(item.runAfter);
    }
    assertBackupSafe(value);
    return value;
  };

  const api=Object.freeze({
    // Request-scoped only: no stale approval data survives this callback.
    readSnapshot(callback){
      if(closed)fail('CLOSED','Store is closed.');if(typeof callback!=='function'||callback.constructor?.name==='AsyncFunction')fail('VALIDATION','A synchronous read callback is required.');
      if(readCache)return callback();const ownTransaction=!transactionDepth;
      if(ownTransaction)db.exec('BEGIN');readCache={queries:new Map(),decoded:new Map()};
      try{const result=callback();if(result&&typeof result.then==='function')fail('VALIDATION','A synchronous read callback is required.');if(ownTransaction)db.exec('COMMIT');return result;}
      catch(error){if(ownTransaction)db.exec('ROLLBACK');throw error;}finally{readCache=null;}
    },
    atomic(callback){return transaction(callback);},
    createRecord(projectId,kind,input,id){
      requireProject(projectId);text(kind,'Record kind',100,true);object(input);
      if(Object.keys(input).some(k=>['id','projectId','kind','revision','createdAt','updatedAt'].includes(k)))fail('VALIDATION','Reserved record field.');
      const value={...json(input,16000000),...base(projectId),kind};if(id!==undefined){text(id,'Record ID',200,true);value.id=id;}
      run('INSERT INTO workspace_records(id,project_id,kind,data) VALUES(?,?,?,?)',value.id,projectId,kind,JSON.stringify(value));return read('workspace_records',value.id);
    },
    getRecord(id){return read('workspace_records',id);},
    listRecords(projectId,kind){requireProject(projectId);return all('SELECT data FROM workspace_records WHERE project_id=? AND kind=? ORDER BY rowid',projectId,kind).map(decoded);},
    updateRecord(id,patch,expectedRevision){return transaction(()=>{const old=requireRecord('workspace_records',id);revision(old,expectedRevision);object(patch);if(Object.keys(patch).some(k=>['id','projectId','kind','revision','createdAt','updatedAt'].includes(k)))fail('VALIDATION','Reserved record field.');const value={...old,...json(patch,16000000),revision:old.revision+1,updatedAt:now()};saveDocument('workspace_records',value);return value;});},
    // Private API: callers must project safe public policy fields explicitly.
    createPolicyRecord(kind,input,id){return transaction(()=>{
      policyKind(kind);const payload=policyPayload(input),value={...payload,...base(),kind};
      if(id!==undefined){text(id,'Record ID',200,true);value.id=id;}
      run('INSERT INTO workspace_policy_records(id,kind,data) VALUES(?,?,?)',value.id,kind,JSON.stringify(value));return read('workspace_policy_records',value.id);
    });},
    getPolicyRecord(id){text(id,'Record ID',200,true);return read('workspace_policy_records',id);},
    listPolicyRecords(kind){policyKind(kind);return all('SELECT data FROM workspace_policy_records WHERE kind=? ORDER BY rowid',kind).map(decoded);},
    updatePolicyRecord(id,patch,expectedRevision){return transaction(()=>{
      const old=requireRecord('workspace_policy_records',id);revision(old,expectedRevision);policyKind(old.kind);
      const value={...old,...policyPayload(patch),revision:old.revision+1,updatedAt:now()};saveDocument('workspace_policy_records',value);return value;
    });},
    observeChecks(pageId,checks,expectedRevision){return transaction(()=>{
      const page=requireRecord('pages',pageId);if(expectedRevision!==undefined&&page.revision!==expectedRevision)return {state:'unknown',checkedAt:now(),summary:'Сторінка змінилася під час перевірки.',code:'STALE_CHECK'};if(!Array.isArray(checks)||!checks.length)fail('VALIDATION','Checks required.');
      for(const check of checks){if(!CHECK_STATES.has(check.state))fail('VALIDATION','Invalid check state.');text(check.kind,'Check kind',100,true);
        const id='incident:'+pageId+':'+check.kind,prior=api.getRecord(id),bad=check.state==='problem';
        if(bad&&(!prior||prior.state==='resolved')){
          const patch={pageId,checkKind:check.kind,state:'open',openedAt:now(),resolvedAt:null,lastSeenAt:now(),occurrences:(prior?.occurrences||0)+1};
          if(prior)api.updateRecord(id,patch,prior.revision);else api.createRecord(page.projectId,'incident',patch,id);
          api.recordEvent({projectId:page.projectId,entityId:pageId,type:prior?'monitor.reopened':'monitor.opened',message:check.kind});
        }else if(prior&&prior.state==='open'&&check.state==='ok'){
          api.updateRecord(id,{state:'resolved',resolvedAt:now(),lastSeenAt:now()},prior.revision);api.recordEvent({projectId:page.projectId,entityId:pageId,type:'monitor.resolved',message:check.kind});
        }else if(prior)api.updateRecord(id,{lastSeenAt:now()},prior.revision);
      }
      const state=checks.some(c=>c.state==='problem')?'problem':checks.some(c=>c.state==='unknown')?'unknown':'ok';
      const summary={state,checkedAt:now(),checkedRevision:page.revision,contentHash:page.remoteSnapshot?.contentHash||null,summary:state==='ok'?'Перевірки пройдено.':state==='problem'?'Є проблеми: '+checks.filter(c=>c.state==='problem').map(c=>c.kind).join(', '):'Частину перевірок не вдалося завершити.'};
      const diagnostics=failedPublishedDiagnostics(checks);if(diagnostics){summary.diagnostics=diagnostics;summary.summary+=' '+publishedDiagnosticMessage(diagnostics);}
      const id='verification:'+pageId,previous=api.getRecord(id);if(previous)api.updateRecord(id,{summary},previous.revision);else api.createRecord(page.projectId,'verification',{pageId,summary},id);
      return summary;
    });},
    pruneChecks(projectId,retentionDays){requireProject(projectId);if(!Number.isSafeInteger(retentionDays)||retentionDays<1)fail('VALIDATION','Retention days required.');const cutoff=timestamp(clock()-retentionDays*86400000);return run("DELETE FROM checks WHERE project_id=? AND json_extract(data,'$.checkedAt')<? AND rowid NOT IN (SELECT MAX(rowid) FROM checks WHERE project_id=? GROUP BY page_id,json_extract(data,'$.kind'))",projectId,cutoff,projectId).changes;},
    createProject(input) {
      const value = { ...projectData(input), ...base() };
      run('INSERT INTO projects(id,data) VALUES(?,?)', value.id, JSON.stringify(value)); return read('projects', value.id);
    },
    listProjects() { return all('SELECT data FROM projects ORDER BY rowid').map(decoded).map(value=>({...value,siteSelection:normalizeSiteCriteria(value.siteSelection)})); },
    getProject(id) { const value=read('projects', id);return value?{...value,siteSelection:normalizeSiteCriteria(value.siteSelection)}:null; },
    updateProject(id, patch, expectedRevision) {
      return transaction(() => {
        const previous = requireProject(id); revision(previous, expectedRevision);
        const value = { ...projectData(patch, previous), revision: previous.revision + 1, updatedAt: now() };
        saveDocument('projects', value); return read('projects', id);
      });
    },
    createSite(projectId, input) {
      return transaction(() => {
        requireProject(projectId); const credentials = credentialInput(input);
        const value = { ...siteData(input), ...base(projectId) };
        run('INSERT INTO sites(id,project_id,enabled,data) VALUES(?,?,?,?)', value.id, projectId, Number(value.enabled), JSON.stringify(value));
        run('INSERT INTO project_site_links(project_id,site_id) VALUES(?,?)',projectId,value.id);
        saveCredentials(value.id, credentials); return publicSite(read('sites', value.id));
      });
    },
    listSites(projectId) { requireProject(projectId); return all('SELECT s.data FROM sites s JOIN project_site_links l ON s.id=l.site_id WHERE l.project_id=? ORDER BY s.rowid', projectId).map(decoded).map(publicSite); },
    listAllSites(){return all('SELECT data FROM sites ORDER BY rowid').map(decoded).map(publicSite);},
    siteBelongsToProject(projectId,siteId){return !!one('SELECT 1 FROM project_site_links WHERE project_id=? AND site_id=?',projectId,siteId);},
    attachSite(projectId,siteId){requireProject(projectId);requireRecord('sites',siteId);run('INSERT OR IGNORE INTO project_site_links(project_id,site_id) VALUES(?,?)',projectId,siteId);return api.getSite(siteId);},
    getSite(id) { return publicSite(read('sites', id)); },
    getSiteCredentials(id) {
      requireRecord('sites', id);
      const stored=storedCredential(id);if(!stored||stored.kind==='browser-login')return null;
      if (!secretBox) fail('KEY_REQUIRED', 'Credential encryption is not configured.');
      return secretBox.decrypt(stored.aad,stored.envelope);
    },
    getBrowserCredentials(id) {
      requireRecord('sites',id);const stored=storedCredential(id);if(!stored||stored.kind!=='browser-login')return null;
      if(!secretBox)fail('KEY_REQUIRED','Credential encryption is not configured.');
      return secretBox.decrypt(stored.aad,stored.envelope);
    },
    updateSite(id, patch, expectedRevision) {
      return transaction(() => {
        const previous = requireRecord('sites', id); revision(previous, expectedRevision);
        const credentials = credentialInput(patch);
        const value = { ...siteData(patch, previous), revision: previous.revision + 1, updatedAt: now() };
        const preserveBrowser=previous.bootstrap?.mode==='browser'||value.bootstrap?.mode==='browser'||storedCredential(id,previous)?.kind==='browser-login';
        run('UPDATE sites SET enabled=?,data=? WHERE id=?', Number(value.enabled), JSON.stringify(value), id);
        saveCredentials(id, credentials,preserveBrowser); return publicSite(read('sites', id));
      });
    },
    createPage(projectId, input) {
      return transaction(() => {
        requireProject(projectId); const value = { ...pageData(input), ...base(projectId) };
        relatedSite(projectId, value.siteId);
        run('INSERT INTO pages(id,project_id,site_id,data) VALUES(?,?,?,?)', value.id, projectId, value.siteId, JSON.stringify(value));
        pageSnapshot(value); return publicPage(read('pages', value.id));
      });
    },
    listPages(projectId) { requireProject(projectId); return all('SELECT data FROM pages WHERE project_id=? ORDER BY rowid', projectId).map(decoded).filter(page=>page.lifecycleState!=='discarded').map(publicPage); },
    // Read current reservation facts without materializing customer HTML, checks or versions.
    listPublishedSiteIds(){return [...new Set(all("SELECT json_extract(data,'$.siteId') AS siteId,json_extract(data,'$.wpId') AS wpId,json_extract(data,'$.lifecycleState') AS lifecycleState FROM pages").filter(page=>page.wpId&&page.lifecycleState!=='discarded').map(page=>page.siteId))];},
    listPageSummaries(projectId){requireProject(projectId);return all('SELECT data FROM pages WHERE project_id=? ORDER BY rowid',projectId).map(decoded).filter(page=>page.lifecycleState!=='discarded').map(page=>({...pick(page,['id','projectId','siteId','title','keyword','fullUrl','wpId','wpType','lifecycleState','revision','createdAt','updatedAt']),verification:pageVerification(page)}));},
    getPage(id) { const page=read('pages',id);return page?.lifecycleState==='discarded'?null:publicPage(page); },
    updatePage(id, patch, expectedRevision) {
      return transaction(() => {
        const previous = requireRecord('pages', id);if(previous.lifecycleState==='discarded')fail('NOT_FOUND','Page was deleted.');revision(previous, expectedRevision);
        const value = { ...pageData(patch, previous), revision: previous.revision + 1, updatedAt: now() };
        relatedSite(value.projectId, value.siteId);
        run('UPDATE pages SET site_id=?,data=? WHERE id=?', value.siteId, JSON.stringify(value), id);
        pageSnapshot(value); return publicPage(read('pages', id));
      });
    },
    createCampaign(projectId, input) {
      fields(input, ['idempotencyKey', 'requestHash', 'name', 'status', 'entries', 'maxPages', 'runReservations']);
      text(input.idempotencyKey, 'Campaign key', 200, true); text(input.requestHash, 'Campaign hash', 64, true);
      text(input.name, 'Campaign name', 300, true);
      if (!['review', 'draft', 'publish'].includes(input.status) || !Array.isArray(input.entries) || input.entries.length < 1 || input.entries.length > 20) fail('VALIDATION', 'Invalid campaign.');
      const entries = json(input.entries, 16 * 1024 * 1024), runReservations = json(input.runReservations ?? [], 100000);
      if (Buffer.byteLength(JSON.stringify(entries), 'utf8') > 16 * 1024 * 1024 || !Array.isArray(runReservations) || runReservations.length > 100) fail('VALIDATION', 'Campaign snapshots exceed their limit.');
      const maxPages = input.maxPages ?? 1000;
      if (!Number.isSafeInteger(maxPages) || maxPages < 1) fail('VALIDATION', 'Invalid campaign capacity.');
      for (const item of runReservations) { fields(item, ['projectId', 'pageId', 'status']); text(item.projectId, 'Project identity', 200, true); text(item.pageId, 'Page identity', 200, true); if (!['review', 'draft', 'publish'].includes(item.status)) fail('VALIDATION', 'Invalid run reservation.'); }
      const noCredentials = value => {
        if (!value || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value)) {
          if (/^(?:authorization|apikey|openaiapikey|username|password|applicationpassword|credentials?|secret|masterkey|privatekey|ciphertext|__proto__|constructor|prototype)$/i.test(key.replace(/[-_ ]/g, ''))) fail('VALIDATION', 'Credential fields cannot be saved in a campaign.');
          noCredentials(child);
        }
      };
      noCredentials(entries); assertBackupSafe(entries);
      return transaction(() => {
        requireProject(projectId);
        const prior = one('SELECT * FROM campaigns WHERE idempotency_key=?', input.idempotencyKey);
        if (prior) { if (prior.project_id !== projectId || prior.request_hash !== input.requestHash) fail('CONFLICT', 'Campaign key was already used.'); return decoded(prior); }
        if (one('SELECT count(*) AS n FROM campaigns').n >= 1000) fail('CAPACITY_EXCEEDED', 'Campaign history is full.');
        const reservations = api.listCampaignReservations(), pending = new Set([...reservations, ...runReservations].map(item => item.pageId));
        if (pending.size + entries.length > 100) fail('CAPACITY_EXCEEDED', 'Automation queue is full.');
        if (input.status !== 'review') {
          const reserved = new Set(all("SELECT id FROM pages WHERE project_id=? AND json_extract(data,'$.wpId') IS NOT NULL", projectId).map(page => page.id));
          for (const job of all("SELECT page_id FROM jobs WHERE project_id=? AND type='publish' AND state IN ('queued','running','paused','uncertain')", projectId)) reserved.add(job.page_id);
          for (const item of api.listCampaignReservations(projectId)) if (item.status !== 'review') reserved.add(item.pageId);
          for (const item of runReservations) if (item.projectId === projectId && item.status !== 'review') reserved.add(item.pageId);
          for (const item of api.listRecords(projectId,'autopilot')) if (item.pageId&&!item.deletedAt&&(item.nativeCapacityReserved||item.nativePublication?.postId)) reserved.add(item.pageId);
          if (reserved.size + entries.length > maxPages) fail('CAPACITY_EXCEEDED', 'Project publication limit is already reserved.');
        }
        const value = { ...base(projectId), idempotencyKey: input.idempotencyKey, requestHash: input.requestHash, name: input.name, status: input.status, state: 'active', items: [] };
        for (const entry of entries) {
          fields(entry, ['page', 'launch', 'generation']);
          if (entry.launch.status !== input.status) fail('VALIDATION', 'Campaign authorization differs.');
          const page = api.createPage(projectId, entry.page), runId = randomUUID();
          value.items.push({ pageId: page.id, siteId: page.siteId, topic: page.keyword || page.title, runId, expectedRevision: page.revision,
            launch: { ...entry.launch, expectedRevision: page.revision, idempotencyKey: runId }, generation: entry.generation,
            state: 'queued', stage: 'queued', errorCode: null, pausedRunRevision: null, pausedJobRevision: null });
        }
        run('INSERT INTO campaigns(id,project_id,idempotency_key,request_hash,data) VALUES(?,?,?,?,?)', value.id, projectId, input.idempotencyKey, input.requestHash, JSON.stringify(value));
        return read('campaigns', value.id);
      });
    },
    getCampaign(id) { return read('campaigns', id); },
    getCampaignByKey(key) { return decoded(one('SELECT data FROM campaigns WHERE idempotency_key=?', key)); },
    listCampaigns(projectId) {
      if (projectId !== undefined && projectId !== null) { requireProject(projectId); return all('SELECT data FROM campaigns WHERE project_id=? ORDER BY rowid', projectId).map(decoded); }
      return all('SELECT data FROM campaigns ORDER BY rowid').map(decoded);
    },
    listCampaignReservations(projectId) {
      return api.listCampaigns(projectId).flatMap(campaign => campaign.items.filter(item => ['queued', 'running', 'paused', 'uncertain'].includes(item.state)).map(item => ({campaignId: campaign.id, pageId: item.pageId, runId: item.runId, status: campaign.status, state: item.state})));
    },
    updateCampaignProgress(id, input) {
      fields(input, ['state', 'items']);
      return transaction(() => {
        const previous = requireRecord('campaigns', id), value = { ...previous, items: previous.items.map(item => ({...item})) };
        if (input.state !== undefined) { if (!['active', 'paused'].includes(input.state)) fail('VALIDATION', 'Invalid campaign state.'); value.state = input.state; }
        if (input.items !== undefined) {
          if (!Array.isArray(input.items) || input.items.length > 20) fail('VALIDATION', 'Invalid campaign progress.');
          for (const patch of input.items) {
            fields(patch, ['pageId', 'state', 'stage', 'errorCode', 'pausedRunRevision', 'pausedJobRevision']);
            const item = value.items.find(item => item.pageId === patch.pageId); if (!item) fail('VALIDATION', 'Unknown campaign page.');
            if (patch.state !== undefined && !['queued', 'running', 'review', 'published', 'draft', 'failed', 'uncertain', 'paused'].includes(patch.state)) fail('VALIDATION', 'Invalid item state.');
            if (patch.stage !== undefined) text(patch.stage, 'Campaign stage', 100, true);
            if (patch.errorCode !== undefined && patch.errorCode !== null && (typeof patch.errorCode !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(patch.errorCode))) fail('VALIDATION', 'Invalid error code.');
            for (const key of ['pausedRunRevision', 'pausedJobRevision']) if (patch[key] !== undefined && patch[key] !== null && (!Number.isSafeInteger(patch[key]) || patch[key] < 1)) fail('VALIDATION', 'Invalid paused revision.');
            Object.assign(item, patch);
          }
        }
        if (canonical(value) === canonical(previous)) return previous;
        value.revision++; value.updatedAt = now(); saveDocument('campaigns', value); return value;
      });
    },
    getGenerationReceipt(id){return decoded(one('SELECT data FROM generation_receipts WHERE id=?',id));},
    commitGeneration(id,input){
      fields(input,['pageId','sourceRevision','patch','publication','quality']);text(id,'Run identity',200,true);
      const hash=createHash('sha256').update(canonical(input)).digest('hex');
      return transaction(()=>{
        const prior=one('SELECT * FROM generation_receipts WHERE id=?',id);
        if(prior){if(prior.request_hash!==hash)fail('CONFLICT','Generation receipt differs.');return JSON.parse(prior.data);}
        const previous=requireRecord('pages',input.pageId);revision(previous,input.sourceRevision);
        if(previous.wpId||one("SELECT 1 FROM jobs WHERE page_id=? AND effect='write' AND state IN ('queued','running','paused','uncertain')",previous.id))fail('CONFLICT','Page already has a remote write.');
        if(input.quality){
          const q=json(input.quality,100000);
          if(q.state!=='passed')fail('CONTENT_FACT_REVIEW_REQUIRED','Generated content needs review.');
          if(q.generatedTextFingerprint){
            if(!/^[a-f0-9]{64}$/.test(q.generatedTextFingerprint))fail('VALIDATION','Invalid fingerprint.');
            const duplicate=one('SELECT page_id FROM generation_fingerprints WHERE fingerprint=?',q.generatedTextFingerprint);
            if(duplicate&&duplicate.page_id!==previous.id)fail('CONTENT_DUPLICATE','Generated text duplicates another page.');
            run('INSERT OR IGNORE INTO generation_fingerprints(fingerprint,page_id,run_id) VALUES(?,?,?)',q.generatedTextFingerprint,previous.id,id);
          }
        }
        const value=api.updatePage(previous.id,input.patch,input.sourceRevision);let job=null;
        if(input.publication){
          const publication=fields(input.publication,['idempotencyKey','mode','html','maxPages']);
          if(!['draft','publish'].includes(publication.mode)||typeof publication.html!=='string'||!publication.html.includes('id="pp-landing"'))fail('VALIDATION','Invalid publication.');
          job=api.enqueueJob({projectId:value.projectId,pageId:value.id,siteId:value.siteId,type:'publish',idempotencyKey:publication.idempotencyKey,maxPages:publication.maxPages,
            payload:{requestRevision:input.sourceRevision,expectedRevision:value.revision,mode:publication.mode,config:value.config,expectedUrls:value.expectedUrls,operation:{kind:'create',postType:value.wpType,title:value.title,content:publication.html,status:publication.mode}}});
        }
        const receipt={runId:id,pageId:value.id,pageRevision:value.revision,jobId:job?.id||null};
        run('INSERT INTO generation_receipts(id,request_hash,data) VALUES(?,?,?)',id,hash,JSON.stringify(receipt));
        api.recordEvent({projectId:value.projectId,entityId:value.id,type:'generation.completed',message:job?'Генерацію завершено; публікацію поставлено в чергу.':'Генерацію завершено; сторінка чекає перегляду.'});
        return receipt;
      });
    },
    addCheck(pageId, input) {
      fields(input, ['kind', 'state', 'evidence']);
      const page = requireRecord('pages', pageId);
      text(input.kind, 'Check kind', 100, true);
      if (!CHECK_STATES.has(input.state)) fail('VALIDATION', 'Unknown check state.');
      const value = { ...base(page.projectId), pageId, kind: input.kind, state: input.state, evidence: safeMetadata(input.evidence ?? {}) };
      value.checkedAt = value.createdAt;
      run('INSERT INTO checks(id,page_id,project_id,data) VALUES(?,?,?,?)', value.id, pageId, page.projectId, JSON.stringify(value)); return read('checks', value.id);
    },
    listLatestProjectChecks(projectId) {
      requireProject(projectId);
      return all("SELECT data FROM checks WHERE rowid IN (SELECT MAX(rowid) FROM checks WHERE project_id=? GROUP BY page_id,json_extract(data,'$.kind')) ORDER BY rowid", projectId).map(decoded).map(c => ({pageId:c.pageId,kind:c.kind,state:c.state,checkedAt:c.checkedAt}));
    },
    listChecks(pageId) { requireRecord('pages', pageId); return all('SELECT data FROM checks WHERE page_id=? ORDER BY rowid', pageId).map(decoded); },
    recordEvent(input) {
      fields(input, ['projectId', 'type', 'entityId', 'message']); requireProject(input.projectId);
      text(input.type, 'Event type', 100, true); text(input.entityId, 'Entity ID', 200, true); text(input.message ?? '', 'Event message', 20000);
      const value = { ...base(input.projectId), type: input.type, entityId: input.entityId, message: safeMetadata(input.message ?? '') };
      run('INSERT INTO events(id,project_id,data) VALUES(?,?,?)', value.id, value.projectId, JSON.stringify(value)); return read('events', value.id);
    },
    listEvents(projectId) { requireProject(projectId); return all('SELECT data FROM events WHERE project_id=? ORDER BY rowid', projectId).map(decoded); },
    assertPublicationCapacity(projectId,pageId,maxPages) {
      requireProject(projectId);
      if (!Number.isSafeInteger(maxPages)||maxPages<1) fail('VALIDATION','Invalid publication capacity.');
      if(requireRecord('pages',pageId).projectId!==projectId)fail('VALIDATION','Page project differs.');
      const count=one("SELECT count(*) AS n FROM (SELECT id AS page_id FROM pages WHERE project_id=? AND json_extract(data,'$.wpId') IS NOT NULL UNION SELECT page_id FROM jobs WHERE project_id=? AND type='publish' AND state IN ('queued','running','uncertain','paused') UNION SELECT json_extract(item.value,'$.pageId') AS page_id FROM campaigns c,json_each(c.data,'$.items') item WHERE c.project_id=? AND json_extract(c.data,'$.status')!='review' AND json_extract(item.value,'$.state') IN ('queued','running','uncertain','paused') UNION SELECT json_extract(data,'$.pageId') AS page_id FROM workspace_records WHERE project_id=? AND kind='autopilot' AND json_extract(data,'$.deletedAt') IS NULL AND (json_extract(data,'$.nativeCapacityReserved')=1 OR json_extract(data,'$.nativePublication.postId') IS NOT NULL) UNION SELECT ? AS page_id)",projectId,projectId,projectId,projectId,pageId).n;
      if(count>maxPages)fail('CAPACITY_EXCEEDED','Project publication limit is already reserved.');
    },
    enqueueJob(input) {
      fields(input, ['projectId', 'siteId', 'pageId', 'type', 'payload', 'idempotencyKey', 'runAfter', 'maxPages']);
      if (input.maxPages !== undefined && (input.type !== 'publish' || !Number.isSafeInteger(input.maxPages) || input.maxPages < 1)) fail('VALIDATION', 'Page limit must be a positive integer for publication jobs.');
      return transaction(() => {
        requireProject(input.projectId);
        if (!own(JOB_TYPES, input.type)) fail('VALIDATION', 'Unsupported job type.');
        if(JOB_TYPES[input.type]==='write'&&requireProject(input.projectId).archived)fail('CONFLICT','Closed projects cannot enqueue new writes.');
        text(input.idempotencyKey, 'Idempotency key', 500, true);
        const pageId = input.pageId ?? null;
        let siteId = input.siteId ?? null;
        if (input.type === 'page_check' || JOB_TYPES[input.type] === 'write') {
          const page = requireRecord('pages', pageId);
          if (page.projectId !== input.projectId || (siteId !== null && siteId !== page.siteId)) fail('VALIDATION', 'Page and job relationships do not match.');
          siteId = page.siteId;
        } else if (siteId === null || pageId !== null) fail('VALIDATION', 'Site checks require only a site identity.');
        if (JOB_TYPES[input.type] === 'write' && siteId === null) fail('VALIDATION', 'Writes require a site.');
        relatedSite(input.projectId, siteId);
        const payload = JOB_TYPES[input.type]==='write' ? json(input.payload ?? {},3000000) : safeMetadata(input.payload ?? {});
        const requestedRunAfter = input.runAfter === undefined ? null : timestamp(input.runAfter);
        const hash = createHash('sha256').update(canonical({ projectId: input.projectId, siteId, pageId, type: input.type, payload, runAfter: requestedRunAfter })).digest('hex');
        const existing = one('SELECT * FROM jobs WHERE idempotency_key=?', input.idempotencyKey);
        if (existing) { if (existing.request_hash !== hash) fail('CONFLICT', 'Idempotency key was already used for a different operation.'); return publicJob(existing); }
        if (input.type === 'publish' && input.maxPages !== undefined) {
          // BEGIN IMMEDIATE makes the limit check and this reservation indivisible across connections.
          api.assertPublicationCapacity(input.projectId,pageId,input.maxPages);
        }
        const record = base(input.projectId);
        run("INSERT INTO jobs(id,project_id,site_id,page_id,type,effect,state,attempt,idempotency_key,request_hash,payload_json,run_after,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',0,?,?,?,?,?,?,?)",
          record.id, input.projectId, siteId, pageId, input.type, JOB_TYPES[input.type], input.idempotencyKey, hash, JSON.stringify(payload), Date.parse(requestedRunAfter ?? record.createdAt), 1, record.createdAt, record.updatedAt);
        return publicJob(jobRow(record.id));
      });
    },
    getJob(id) { return publicJob(jobRow(id)); },
    createProposal(pageId,input) {
      fields(input,['expectedPageRevision','diff','nextConfig','expectedContentHash','registryProposal','kind']);
      return transaction(()=>{const page=requireRecord('pages',pageId);revision(page,input.expectedPageRevision);
        const value={...json(input),...base(page.projectId),pageId,state:'pending'};
        run('INSERT INTO proposals(id,page_id,data) VALUES(?,?,?)',value.id,pageId,JSON.stringify(value));return value;});
    },
    getProposal(id) {return read('proposals',id);},
    confirmProposal(id,expectedRevision) {
      return transaction(()=>{const value=requireRecord('proposals',id);
        if(value.state==='confirmed'&&value.confirmedFromRevision===expectedRevision)return value;
        revision(value,expectedRevision);if(value.state!=='pending')fail('CONFLICT','Proposal is not pending.');
        revision(requireRecord('pages',value.pageId),value.expectedPageRevision);
        const next={...value,state:'confirmed',confirmedFromRevision:expectedRevision,revision:value.revision+1,confirmedAt:now(),updatedAt:now()};saveDocument('proposals',next);return next;});
    },
    completeRemoteWrite(id, input) {
      fields(input, ['leaseToken', 'expectedPageRevision', 'patch', 'result']);
      return transaction(() => {
        const row = jobRow(id), time = now();
        if (row.effect !== 'write') fail('VALIDATION', 'Only remote writes use atomic completion.');
        // A second callback or reconciliation cannot mutate the page again, even with stale input.
        if (row.state === 'completed') return publicJob(row);
        if (row.state === 'running') {
          if (typeof input.leaseToken !== 'string' || row.lease_token !== input.leaseToken || row.lease_until <= Date.parse(time)) fail('LEASE_CONFLICT', 'Job lease is no longer active.');
        } else if (row.state === 'uncertain') {
          if (input.leaseToken !== undefined) fail('LEASE_CONFLICT', 'Uncertain writes require explicit reconciliation without a lease.');
        } else fail('CONFLICT', 'Write is not running or awaiting reconciliation.');
        const previous = requireRecord('pages', row.page_id);
        if (previous.projectId !== row.project_id || previous.siteId !== row.site_id || row.site_id === null) fail('CONFLICT', 'Page is no longer associated with this operation site.');
        revision(previous, input.expectedPageRevision);
        const value = { ...pageData(input.patch, previous), revision: previous.revision + 1, updatedAt: time };
        if (value.siteId !== row.site_id) fail('CONFLICT', 'Completion cannot change the operation site.');
        relatedSite(value.projectId, value.siteId);
        // Verified authored data and destinations stay exact; no substring redaction belongs here.
        const result = json(input.result ?? {});
        run('UPDATE pages SET site_id=?,data=? WHERE id=?', value.siteId, JSON.stringify(value), value.id);
        pageSnapshot(value);
        run("UPDATE jobs SET state='completed',result_json=?,error_json=NULL,worker_id=NULL,lease_token=NULL,lease_until=NULL,revision=revision+1,updated_at=? WHERE id=?", JSON.stringify(result), time, id);
        const event = { ...base(row.project_id), type: 'remote_write.completed', entityId: value.id, message: 'Remote write completed: ' + row.id };
        run('INSERT INTO events(id,project_id,data) VALUES(?,?,?)', event.id, event.projectId, JSON.stringify(event));
        return publicJob(jobRow(id));
      });
    },
    markWriteAbsent(id,expectedRevision){return transaction(()=>{const row=jobRow(id);if(row.effect!=='write'||row.state!=='uncertain'||row.revision!==expectedRevision)fail('CONFLICT','Write is not awaiting reconciliation.');const result={...(row.result_json?JSON.parse(row.result_json):{}),recovery:{canRetry:true,checkedAt:now(),operationId:id}};run('UPDATE jobs SET result_json=?,revision=revision+1,updated_at=? WHERE id=?',JSON.stringify(result),now(),id);return publicJob(jobRow(id));});},
    // Explicit recovery only: first return to ledger reconciliation; never dispatch a failed write directly.
    reconsiderFailedWrite(id,expectedRevision){return transaction(()=>{const row=jobRow(id),payload=JSON.parse(row.payload_json),page=requireRecord('pages',row.page_id);if(row.effect!=='write'||row.state!=='failed'||row.revision!==expectedRevision||row.attempt>=3||page.revision!==payload.expectedRevision||page.siteId!==row.site_id)fail('CONFLICT','An unchanged failed write is required.');run("UPDATE jobs SET state='uncertain',revision=revision+1,updated_at=? WHERE id=?",now(),id);return publicJob(jobRow(id));});},
    retryUncertainJob(id,input){fields(input,['expectedRevision','verifiedAbsent']);return transaction(()=>{const row=jobRow(id),result=row.result_json?JSON.parse(row.result_json):null,payload=JSON.parse(row.payload_json),page=requireRecord('pages',row.page_id);if(requireProject(row.project_id).archived||row.effect!=='write'||row.state!=='uncertain'||row.revision!==input.expectedRevision||input.verifiedAbsent!==true||result?.recovery?.canRetry!==true||row.attempt>=3||page.revision!==payload.expectedRevision||page.siteId!==row.site_id)fail('CONFLICT','A fresh absent ledger result and unchanged page are required.');run("UPDATE jobs SET state='queued',run_after=?,result_json=NULL,error_json=NULL,worker_id=NULL,lease_token=NULL,lease_until=NULL,revision=revision+1,updated_at=? WHERE id=?",clock(),now(),id);return publicJob(jobRow(id));});},
    reconcileJob(id,input) {
      fields(input,['state','result','error']);if(input.state !== 'failed')fail('VALIDATION','Successful writes require atomic page completion.');
      return transaction(()=>{const row=jobRow(id);if(row.effect!=='write'||row.state!=='uncertain')fail('CONFLICT','Only uncertain writes may be reconciled.');
        run('UPDATE jobs SET state=?,result_json=?,error_json=?,revision=revision+1,updated_at=? WHERE id=?',input.state,JSON.stringify(safeMetadata(input.result??{})),JSON.stringify(safeMetadata(input.error??{})),now(),id);return publicJob(jobRow(id));});
    },
    listJobs(projectId) { requireProject(projectId); return all('SELECT * FROM jobs WHERE project_id=? ORDER BY created_at,rowid', projectId).map(publicJob); },
    claimJob(input) {
      fields(input, ['workerId', 'leaseMs', 'allowedWriteJobId']); text(input.workerId, 'Worker identity', 200, true);
      if(input.allowedWriteJobId!==undefined&&input.allowedWriteJobId!==null)text(input.allowedWriteJobId,'Allowed write identity',200,true);
      if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1 || input.leaseMs > 3600000) fail('VALIDATION', 'Lease duration must be between 1ms and one hour.');
      return transaction(() => {
        const time = now(); recover(time);
        const row = one("SELECT j.* FROM jobs j LEFT JOIN sites s ON s.id=j.site_id WHERE j.state='queued' AND j.run_after<=? AND j.attempt<3 AND (j.effect='read' OR ?=1 OR j.id=?) AND (j.site_id IS NULL OR s.enabled=1 OR (j.type='site_check' AND j.effect='read' AND json_extract(s.data,'$.bootstrap.restored')=1)) AND NOT EXISTS(SELECT 1 FROM jobs active WHERE active.site_id=j.site_id AND active.state='running') ORDER BY j.run_after,j.created_at,j.rowid LIMIT 1", Date.parse(time),input.allowedWriteJobId===undefined?1:0,input.allowedWriteJobId??null);
        if (!row) return null;
        const token = randomUUID();
        run("UPDATE jobs SET state='running',attempt=attempt+1,worker_id=?,lease_token=?,lease_until=?,revision=revision+1,updated_at=? WHERE id=?", input.workerId, token, Date.parse(time) + input.leaseMs, time, row.id);
        return { ...publicJob(jobRow(row.id)), leaseToken: token };
      });
    },
    renewJob(id,leaseToken,leaseMs=180000){
      if(!Number.isSafeInteger(leaseMs)||leaseMs<1||leaseMs>3600000)fail('VALIDATION','Invalid lease duration.');
      return transaction(()=>{const row=jobRow(id),time=now();if(row.state!=='running'||typeof leaseToken!=='string'||row.lease_token!==leaseToken||row.lease_until<=Date.parse(time))fail('LEASE_CONFLICT','Job lease is no longer active.');run('UPDATE jobs SET lease_until=?,revision=revision+1,updated_at=? WHERE id=?',Date.parse(time)+leaseMs,time,id);return publicJob(jobRow(id));});
    },
    finishJob(id, leaseToken, input) {
      fields(input, ['state', 'result', 'error']);
      if (!['completed', 'failed', 'uncertain'].includes(input.state)) fail('VALIDATION', 'Unknown terminal job state.');
      return transaction(() => {
        const row = jobRow(id), time = now();
        if (row.state !== 'running' || typeof leaseToken !== 'string' || row.lease_token !== leaseToken || row.lease_until <= Date.parse(time)) fail('LEASE_CONFLICT', 'Job lease is no longer active.');
        if (row.effect === 'write' && input.state === 'completed') fail('VALIDATION', 'Successful writes require atomic page completion.');
        const result = input.result === undefined ? null : safeMetadata(input.result);
        const error = input.error === undefined ? null : safeMetadata(input.error);
        run('UPDATE jobs SET state=?,result_json=?,error_json=?,worker_id=NULL,lease_token=NULL,lease_until=NULL,revision=revision+1,updated_at=? WHERE id=?', input.state, result === null ? null : JSON.stringify(result), error === null ? null : JSON.stringify(error), time, id);
        return publicJob(jobRow(id));
      });
    },
    pauseJob(id) {
      return transaction(() => {
        const row = jobRow(id);
        if (row.state === 'paused') return publicJob(row);
        if (!['queued', 'running'].includes(row.state)) fail('CONFLICT', 'A finished job cannot be paused.');
        const state = row.state === 'running' && row.effect === 'write' ? 'uncertain' : 'paused';
        run('UPDATE jobs SET state=?,worker_id=NULL,lease_token=NULL,lease_until=NULL,revision=revision+1,updated_at=? WHERE id=?', state, now(), id);
        return publicJob(jobRow(id));
      });
    },
    resumeJob(id) {
      return transaction(()=>{const row=jobRow(id);if(requireProject(row.project_id).archived||row.state!=='paused'||row.attempt>=3)fail('CONFLICT','Only paused, unexhausted jobs in an active project can resume.');
        run("UPDATE jobs SET state='queued',run_after=?,revision=revision+1,updated_at=? WHERE id=?",Date.parse(now()),now(),id);return publicJob(jobRow(id));});
    },
    recoverExpiredJobs() { return transaction(() => recover(now())); },
    exportBackup() {
      return transaction(() => {
        const metadata = ['id', 'projectId', 'revision', 'createdAt', 'updatedAt'];
        const backup = {
          kind: 'pageposter-lifecycle-backup', schemaVersion: 2, exportedAt: now(),siteLinks:all('SELECT project_id AS projectId,site_id AS siteId FROM project_site_links'),
          projects: all('SELECT data FROM projects ORDER BY rowid').map(decoded),
          sites: all('SELECT data FROM sites ORDER BY rowid').map(decoded),
          pages: all('SELECT data FROM pages ORDER BY rowid').map(decoded),
          pageVersions: all('SELECT data FROM page_versions ORDER BY rowid').map(decoded),
          checks: all('SELECT data FROM checks ORDER BY rowid').map(decoded).map(value => pick(value, [...metadata, 'pageId', 'kind', 'state', 'checkedAt'])),
          events: all('SELECT data FROM events ORDER BY rowid').map(decoded).map(value => pick(value, [...metadata, 'type', 'entityId'])),
          jobs: all('SELECT * FROM jobs ORDER BY rowid').map(publicJob).map(value => pick(value, [...metadata, 'siteId', 'pageId', 'operationId', 'type', 'effect', 'state', 'attempt', 'runAfter']))
        };
        assertBackupSafe(backup);
        return backup;
      });
    },
    restoreBackup(input) {
      return transaction(() => {
        for (const table of ['projects', 'sites', 'site_credentials', 'pages', 'page_versions', 'checks', 'events', 'jobs', 'proposals', 'workspace_policy_records']) {
          if (one('SELECT 1 FROM ' + table + ' LIMIT 1')) fail('RESTORE_NOT_EMPTY', 'Restore requires an empty store.');
        }
        const backup = validatedBackup(input);
        for (const item of backup.projects) run('INSERT INTO projects(id,data) VALUES(?,?)', item.id, JSON.stringify(item));
        for (const item of backup.sites) {
          const restored = { ...item, enabled: false }; delete restored.hasCredential;
          run('INSERT INTO sites(id,project_id,enabled,data) VALUES(?,?,0,?)', item.id, item.projectId, JSON.stringify(restored));
        }
        for(const item of backup.siteLinks||backup.sites.map(s=>({projectId:s.projectId,siteId:s.id})))run('INSERT OR IGNORE INTO project_site_links(project_id,site_id) VALUES(?,?)',item.projectId,item.siteId);
        for (const item of backup.pages) run('INSERT INTO pages(id,project_id,site_id,data) VALUES(?,?,?,?)', item.id, item.projectId, item.siteId, JSON.stringify(item));
        for (const item of backup.pageVersions) run('INSERT INTO page_versions(id,page_id,revision,data) VALUES(?,?,?,?)', item.id, item.pageId, item.revision, JSON.stringify(item));
        for (const item of backup.checks) run('INSERT INTO checks(id,page_id,project_id,data) VALUES(?,?,?,?)', item.id, item.pageId, item.projectId, JSON.stringify({ ...item, evidence: {} }));
        for (const item of backup.events) run('INSERT INTO events(id,project_id,data) VALUES(?,?,?)', item.id, item.projectId, JSON.stringify({ ...item, message: '' }));
        // Job metadata is historical only. No runnable job, credential, or proposal is imported.
        return { projects: backup.projects.length, sites: backup.sites.length, pages: backup.pages.length, pageVersions: backup.pageVersions.length, checks: backup.checks.length, events: backup.events.length, skippedJobs: backup.jobs.length };
      });
    },
    close() { if (!closed) { db.close(); closed = true; } }
  });
  return api;
}

