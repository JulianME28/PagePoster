import {createHash} from 'node:crypto';
import {expectedHtmlFor,comparePublishedContent} from './published-content.mjs';
import {expectedNativeCounts} from './native-link-policy.mjs';
// Read-only WordPress discovery and monitoring. No publication, plugin install,
// offer-link fetching, script execution or robots mutation occurs here.
import { JSDOM } from './dom-runtime.mjs';
import { createSafeTransport, validatePublicUrl, NetworkError } from './network.mjs';
const KINDS = ['public','content','wp_access','wp_status','wp_content','noindex','robots','links'];
function snapshotHash(values){const hash=createHash('sha256').update('pageposter-snapshot-v1\0');for(const value of values){hash.update(String(Buffer.byteLength(value,'utf8'))+':');hash.update(value);}return hash.digest('hex');}
const NETWORK_CODES = new Set(['unsafe_url','unsafe_address','dns_failed','network_failed','network_timeout','invalid_redirect','too_many_redirects','response_too_large','unsupported_encoding','cross_origin_redirect','invalid_response']);
// Recovery consumes a structured code; keep the existing human evidence too.
// Untrusted transport errors are mapped through errorCode's allowlist first.
const check = (kind,state,evidence,code) => ({ kind,state,evidence:code ? evidence+' ['+code+']' : evidence,...(typeof code==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(code)?{code}:{}) });
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const good = status => status >= 200 && status < 300;
const errorCode = error => NETWORK_CODES.has(error?.code) ? error.code : 'network_failed';
const headers = (response,name) => {
  const found = Object.entries(response?.headers || {}).find(([key]) => key.toLowerCase() === name);
  return found ? (Array.isArray(found[1]) ? found[1] : [String(found[1])]) : [];
};
const header = (response,name) => headers(response,name).join(', ');
function parseJSON(response) { try { return JSON.parse(response.text); } catch { return null; } }
function doc(html) { return new JSDOM(html); } // No resource/script loading.
function inputSite(site) {
  const base = validatePublicUrl(site?.baseUrl);
  base.hash = '';
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  return base;
}
function credentials(site) {
  if (typeof site.username !== 'string' || !site.username || /[:\r\n\u0000]/.test(site.username) || site.username.length > 256 ||
      typeof site.applicationPassword !== 'string' || !site.applicationPassword.trim() || /[\r\n\u0000]/.test(site.applicationPassword) || site.applicationPassword.length > 1024) return null;
  return { authorization:'Basic '+Buffer.from(site.username+':'+site.applicationPassword,'utf8').toString('base64'), accept:'application/json' };
}
function apiUrl(root,path,params = {}) {
  const url = new URL(root);
  if (url.searchParams.has('rest_route')) url.searchParams.set('rest_route',path);
  else url.pathname = url.pathname.replace(/\/?$/,'/')+path.replace(/^\//,'');
  for (const [key,value] of Object.entries(params)) url.searchParams.set(key,value);
  url.hash = ''; return url.href;
}
function authFailure(response) {
  const data = parseJSON(response);
  if (!object(data) || typeof data.code !== 'string') return null;
  if (response.status === 401) return 'authentication_failed';
  if (response.status === 403) return 'permission_denied';
  return null;
}
function emptyCapabilities() { return { publicRead:null,read:null,edit:null,create:null,publish:null,install:null,activate:null }; }
function unknownPlugin() { return { state:'unknown',evidence:'Plugin state could not be read.' }; }
function pluginResult(list,slug) {
  const entry = list.find(item => object(item) && typeof item.plugin === 'string' && item.plugin.split('/')[0] === slug);
  if (!entry) return { state:'missing',evidence:'Plugin is absent from the authenticated plugin list.' };
  const state = entry.status === 'active' || entry.status === 'network-active' ? 'active' : entry.status === 'inactive' ? 'inactive' : 'unknown';
  const requiredVersion=slug==='pageposter-bridge'?'0.2.1':'1.1.1',version=typeof entry.version==='string'&&/^\d[\w.+-]{0,39}$/.test(entry.version)?entry.version:null;
  return {state,...(version?{version}:{}),requiredVersion,compatible:state==='active'&&version===requiredVersion,evidence:'State/version reported by the authenticated WordPress Plugins API; Bridge status must also verify required runtime features.'};
}
function markerCheck(document,expected) {
  if (typeof expected !== 'string' || !expected.trim()) return check('content','unknown','No expected content marker was supplied.');
  if (expected.length > 512) return check('content','unknown','The expected content marker is invalid.');
  const id = expected.startsWith('#') ? expected.slice(1) : expected;
  const byId = document.getElementById(id);
  let found = !!byId && !['SCRIPT','STYLE','TEMPLATE'].includes(byId.tagName);
  if (!found) for (const element of document.querySelectorAll('*')) {
    if (['SCRIPT','STYLE','TEMPLATE'].includes(element.tagName)) continue;
    if (Array.from(element.attributes).some(attribute => attribute.name === expected || (attribute.name.startsWith('data-') && attribute.value === expected))) { found = true; break; }
  }
  return found ? check('content','ok','The expected marker exists in the HTML document; visual/browser verification is separate.') : check('content','problem','The expected content marker is missing; this may be a different page, stale cache or a challenge response.','content_mismatch');
}
function noindexCheck(document,response) {
  const reasons = []; let uncertain = false;
  const restricted = text => /(?:^|[\s,;])(noindex|none)(?:$|[\s,;])/i.test(text);
  for (const meta of document.querySelectorAll('meta[name]')) {
    const name = meta.getAttribute('name').trim().toLowerCase();
    if (!['robots','googlebot'].includes(name)) continue;
    const value = meta.getAttribute('content') || '';
    if (restricted(value)) reasons.push('meta '+name);
    if (/unavailable_after\s*:/i.test(value)) uncertain = true;
  }
  const directiveNames = new Set(['max-snippet','max-image-preview','max-video-preview','unavailable_after']);
  for (const value of headers(response,'x-robots-tag')) {
    let scope = '*';
    for (let segment of value.split(',')) {
      segment = segment.trim();
      const match = /^([a-z0-9_*.-]+)\s*:\s*(.*)$/i.exec(segment);
      if (match && !directiveNames.has(match[1].toLowerCase())) { scope = match[1].toLowerCase(); segment = match[2]; }
      if (!['*','googlebot'].includes(scope)) continue;
      if (restricted(segment)) reasons.push('X-Robots-Tag');
      if (/unavailable_after\s*:/i.test(segment)) uncertain = true;
    }
  }
  if (reasons.length) return check('noindex','problem','Indexing restriction found in '+[...new Set(reasons)].join(' and ')+'.','noindex_detected');
  if (uncertain) return check('noindex','unknown','An unavailable_after directive needs a separate expiry evaluation.');
  return check('noindex','ok','No applicable noindex/none directive in this HTTP response or static HTML. This does not prove Google indexing.');
}
function canonicalRobotsPath(value) {
  if (/%(?![0-9a-f]{2})/i.test(value) || /[\u0000-\u0020\u007f]/.test(value)) return null;
  return Array.from(value).map(char => char.charCodeAt(0) > 127 ? encodeURIComponent(char) : char).join('')
    .replace(/%([0-9a-f]{2})/gi,(whole,hex) => {
      const char = String.fromCharCode(parseInt(hex,16));
      return /[A-Za-z0-9._~-]/.test(char) ? char : '%'+hex.toUpperCase();
    });
}
// Glob matching uses ordered literal segments, never a backtracking regexp
// built from an untrusted robots file.
function matchesRobotsPattern(path,pattern,end) {
  const parts = pattern.split('*');
  if (!path.startsWith(parts[0])) return false;
  let cursor = parts[0].length;
  if (parts.length === 1) return !end || cursor === path.length;
  for (let i=1; i<parts.length; i++) {
    const part = parts[i];
    if (end && i === parts.length-1) return path.endsWith(part) && path.length-part.length >= cursor;
    if (!part) continue;
    const position = path.indexOf(part,cursor);
    if (position < 0) return false;
    cursor = position+part.length;
  }
  return true;
}
function robotsRules(text,url) {
  if (Buffer.byteLength(text,'utf8') > 500*1024 || /[\u0000\ufffd]/.test(text) || /<\s*(?:!doctype|html|head|body|script)\b/i.test(text)) return check('robots','unknown','robots.txt is too large, malformed or an HTML/challenge response.');
  const groups = []; let group = null, invalid = false;
  for (const raw of text.replace(/^\ufeff/,'').split(/\r\n|\r|\n/)) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const parts = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!parts) { invalid = true; continue; }
    const field = parts[1].toLowerCase(), value = parts[2].trim();
    if (field === 'user-agent') {
      if (!/^(?:\*|[a-z0-9_-]+)$/i.test(value)) { invalid = true; continue; }
      if (!group || group.hasRules) { group = { agents:[],rules:[],hasRules:false }; groups.push(group); }
      group.agents.push(value.toLowerCase());
    } else if (field === 'allow' || field === 'disallow') {
      if (!group) { invalid = true; continue; }
      group.hasRules = true;
      if (!value) continue;
      const pattern = canonicalRobotsPath(value);
      if (!pattern || pattern.length > 8192 || !pattern.startsWith('/')) { invalid = true; continue; }
      group.rules.push({ allow:field === 'allow',pattern });
    } else if (!['sitemap','crawl-delay','host'].includes(field)) invalid = true;
  }
  if (invalid) return check('robots','unknown','robots.txt contains unsupported or malformed rules; no crawl permission is assumed.');
  const specific = groups.filter(item => item.agents.includes('googlebot'));
  const selected = specific.length ? specific : groups.filter(item => item.agents.includes('*'));
  const path = canonicalRobotsPath(url.pathname+url.search);
  if (!path) return check('robots','unknown','This URL encoding could not be evaluated against robots.txt.');
  let winner = null;
  for (const rule of selected.flatMap(item => item.rules)) {
    const end = rule.pattern.endsWith('$'), pattern = end ? rule.pattern.slice(0,-1) : rule.pattern;
    if (!matchesRobotsPattern(path,pattern,end)) continue;
    const length = Buffer.byteLength(pattern.replace(/\*/g,''),'utf8');
    if (!winner || length > winner.length || (length === winner.length && rule.allow)) winner = { ...rule,length };
  }
  return winner && !winner.allow ? check('robots','problem','The matching robots.txt rule Disallow: '+winner.pattern+' disallows Googlebot for '+path+'.','crawl_disallowed') :
    check('robots','ok','No matching Googlebot crawl prohibition in the fetched robots.txt; indexing is a separate check.');
}
function linksCheck(document,response,page) {
  if (!Array.isArray(page.expectedUrls)) return check('links','unknown','No expected outbound URL list was supplied.');
  if (page.expectedUrls.some(url => typeof url !== 'string' || !/^https?:\/\//i.test(url) || /[\u0000-\u0020]/.test(url))) return check('links','unknown','The expected outbound URL list is invalid.');
  const expected = new Set(page.expectedUrls), counts = new Map(), extras = new Set();
  const origin = new URL(response.url).origin;
  let linkBase = response.url;
  try { const base = document.querySelector('base[href]'); if (base) linkBase = new URL(base.getAttribute('href'),response.url).href; }
  catch { return check('links','unknown','The HTML base destination could not be resolved.'); }
  let invalid = false;
  for (const node of document.querySelectorAll('a[href],area[href],[data-pp-url]')) {
    for (const attribute of ['href','data-pp-url']) {
      if (!node.hasAttribute(attribute) || (attribute === 'href' && !['A','AREA'].includes(node.tagName))) continue;
      const literal = node.getAttribute(attribute);
      if (!literal || literal.startsWith('#')) continue;
      let absolute;
      try { absolute = new URL(literal,linkBase); } catch { invalid = true; continue; }
      if (!['http:','https:'].includes(absolute.protocol)) { if (!['mailto:','tel:'].includes(absolute.protocol)) invalid = true; else extras.add(literal); continue; }
      if (absolute.origin === origin && !expected.has(literal)) continue;
      // getAttribute decodes entities once. The .href property would normalize
      // exact user query encoding and tracking parameters, hiding regressions.
      if (!expected.has(literal)) extras.add(literal);
      if (attribute === 'href') counts.set(literal,(counts.get(literal) || 0)+1);
    }
  }
  const nativeCounts=expectedNativeCounts(expectedHtmlFor(page));
  const missing = [...expected].filter(url => (counts.get(url)||0)<(nativeCounts.get(url)||1));
  const duplicate = [...expected].filter(url => counts.get(url) > (nativeCounts.get(url)||1));
  if (missing.length || duplicate.length || extras.size || invalid) return check('links','problem',
    'Static link mismatch: '+missing.length+' missing, '+duplicate.length+' repeated native hrefs, '+extras.size+' unexpected destinations'+(invalid ? ', malformed destinations' : '')+'.','link_mismatch');
  return check('links','ok','Static HTML has '+expected.size+' exact unique outbound URLs with the required native link groups. JavaScript controls require separate browser verification.');
}
/** transport(url,{method:'GET',headers}) => {status,headers,text,url?,redirects?}.
 * A transport is a trusted server dependency, never supplied by an API caller. */
export function createWordPressClient({ transport = createSafeTransport() } = {}) {
  async function read(url,auth,origin) {
    const validated = validatePublicUrl(url);
    if (auth && validated.origin !== origin) throw new NetworkError('cross_origin_redirect');
    const raw = await transport(url,{ method:'GET',sameOriginOnly:true,headers:auth || {accept:'text/html,application/json,text/plain;q=0.9'} });
    const body = typeof raw?.text === 'function' ? await raw.text() : raw?.text;
    if (!raw || !Number.isInteger(raw.status) || typeof body !== 'string' || Buffer.byteLength(body,'utf8') > 2*1024*1024) throw new NetworkError('invalid_response');
    const responseHeaders = typeof raw.headers?.entries === 'function' ? Object.fromEntries(raw.headers.entries()) : (raw.headers || {});
    const final = validatePublicUrl(raw.url || url);
    if (auth && (final.origin !== origin || raw.redirects?.some(hop => new URL(hop.from).origin !== new URL(hop.to).origin))) throw new NetworkError('cross_origin_redirect');
    return {status:raw.status,headers:responseHeaders,text:body,url:final.href,redirects:raw.redirects || []};
  }
  async function discover(base) {
    let home = null;
    try { home = await read(base.href); } catch { /* REST discovery can still work. */ }
    const candidates = []; let wpVersion = null;
    if (home && new URL(home.url).origin === base.origin) {
      for (const match of header(home,'link').matchAll(/<([^>]+)>\s*;\s*rel\s*=\s*(?:"([^"]+)"|([^,;\s]+))/gi)) {
        if ((match[2] || match[3]).split(/\s+/).includes('https://api.w.org/')) candidates.push(match[1]);
      }
      const dom = doc(home.text);
      try {
        for (const link of dom.window.document.querySelectorAll('link[rel][href]')) if (link.getAttribute('rel').split(/\s+/).includes('https://api.w.org/')) candidates.push(link.getAttribute('href'));
        for (const meta of dom.window.document.querySelectorAll('meta[name="generator"]')) {
          const version = /^WordPress\s+(\d+\.\d+(?:\.\d+)?)/i.exec(meta.getAttribute('content') || '');
          if (version) wpVersion = version[1];
        }
      } finally { dom.window.close(); }
    }
    const pretty = new URL(base); pretty.search = ''; pretty.pathname = pretty.pathname.replace(/\/?$/,'/')+'wp-json/';
    const query = new URL(base); query.search = '?rest_route=/';
    candidates.push(pretty.href,query.href);
    const seen = new Set(); let lastCode = 'rest_unavailable';
    for (const candidate of candidates.slice(0,8)) {
      let endpoint;
      try { endpoint = validatePublicUrl(new URL(candidate,base).href); } catch { continue; }
      if (endpoint.origin !== base.origin || seen.has(endpoint.href)) continue;
      seen.add(endpoint.href);
      try {
        const response = await read(endpoint.href);
        if (new URL(response.url).origin !== base.origin || !good(response.status)) continue;
        const index = parseJSON(response);
        if (object(index) && Array.isArray(index.namespaces) && index.namespaces.includes('wp/v2')) return {home,apiRoot:response.url,index,wpVersion};
      } catch (error) { lastCode = errorCode(error); }
    }
    return {home,apiRoot:null,index:null,wpVersion,code:lastCode};
  }
  async function checkSite(site) {
    const result = { state:'unknown',code:null,apiRoot:null,wpVersion:null,capabilities:emptyCapabilities(),plugins:{bridge:unknownPlugin(),cleanLinks:unknownPlugin()},bootstrap:{state:'bootstrap_required',evidence:'The custom ZIP requires a one-time authorized wp-admin or WP-CLI installation. Application Passwords authenticate API requests, not browser login.'},checks:[] };
    let base;
    try { base = inputSite(site); } catch (error) { result.state='problem'; result.code=errorCode(error); result.checks.push(check('public','problem','A public HTTPS URL without embedded credentials is required.',result.code)); return result; }
    const found = await discover(base);
    result.apiRoot = found.apiRoot; result.wpVersion = found.wpVersion;
    result.capabilities.publicRead = found.home ? good(found.home.status) : null;
    result.checks.push(check('public',found.home ? (good(found.home.status) ? 'ok' : 'problem') : 'unknown',found.home ? 'Public site HTTP '+found.home.status+'.' : 'The public site response was unavailable.'));
    if (!found.apiRoot) { result.code=found.code; result.checks.push(check('rest','unknown','A same-origin WordPress REST endpoint was not verified.',found.code)); return result; }
    result.checks.push(check('rest','ok','A same-origin WordPress REST endpoint was verified.'));
    result.applicationPasswordsAdvertised = !!found.index.authentication?.['application-passwords'];
    const auth = credentials(site);
    if (!auth) { result.state='problem'; result.code='credentials_required'; result.checks.push(check('auth','problem','A username and Application Password are required.',result.code)); return result; }
    let userResponse;
    try { userResponse = await read(apiUrl(found.apiRoot,'/wp/v2/users/me',{context:'edit'}),auth,base.origin); }
    catch (error) { result.code=errorCode(error); result.checks.push(check('auth','unknown','Authenticated REST access could not be verified.',result.code)); return result; }
    const failed = authFailure(userResponse), user = parseJSON(userResponse);
    if (failed) { result.state='problem'; result.code=failed; result.checks.push(check('auth','problem','WordPress rejected the supplied API authentication or required permission.',failed)); return result; }
    if (!good(userResponse.status) || !object(user) || !Number.isInteger(user.id) || user.id < 1) { result.code='authentication_unverified'; result.checks.push(check('auth','unknown','The response did not verify an authenticated WordPress user.',result.code)); return result; }
    result.state='ok'; result.code=null; result.checks.push(check('auth','ok','WordPress verified the authenticated user through users/me in edit context.'));
    if (object(user.capabilities)) {
      const cap = name => user.capabilities[name] === true;
      result.capabilities = { ...result.capabilities,read:cap('read'),edit:cap('edit_pages'),create:cap('edit_pages'),publish:cap('publish_pages'),install:cap('install_plugins'),activate:cap('activate_plugins') };
      result.postCapabilities = {edit:cap('edit_posts'),create:cap('edit_posts'),publish:cap('publish_posts')};
    }
    result.checks.push(check('capabilities',object(user.capabilities) ? 'ok' : 'unknown','Capabilities are reported user permissions, not proof of filesystem access, unfiltered HTML or a successful write.'));
    try {
      const pluginResponse = await read(apiUrl(found.apiRoot,'/wp/v2/plugins',{context:'edit'}),auth,base.origin);
      const list = parseJSON(pluginResponse);
      if (good(pluginResponse.status) && Array.isArray(list)) {
        result.plugins.cleanLinks = pluginResult(list,'pageposter-clean-links');
        result.plugins.bridge = pluginResult(list,'pageposter-bridge');
      }
    } catch { /* Plugin listing may require permissions the editor does not have. */ }
    if (result.plugins.bridge.state === 'unknown' && found.index.namespaces.some(namespace => /^pageposter(?:-bridge)?\//.test(namespace))) result.plugins.bridge = {state:'discovered',evidence:'A Bridge namespace is advertised; activation and operation guarantees are not verified.'};
    if (result.plugins.bridge.state === 'active') result.bootstrap = result.plugins.bridge.compatible&&result.plugins.cleanLinks.compatible?{state:'bridge_detected',evidence:'Required plugin versions are listed; runtime capability verification is still required before a write.'}:{state:'update_required',evidence:'Install the supplied PagePoster Bridge 0.2.1 and Clean Links 1.1.1 ZIPs. Activation alone does not prove required features.'};
    return result;
  }
  async function checkPage({ site,page,publicOnly=false } = {}) {
    let base, pageUrl;
    try {
      base = inputSite(site); pageUrl = validatePublicUrl(page?.fullUrl);
      if (pageUrl.origin !== base.origin) throw new NetworkError('unsafe_url');
    } catch (error) { return KINDS.map(kind => check(kind,kind === 'public' ? 'problem' : 'unknown','The page must use the registered public HTTPS site origin.',errorCode(error))); }
    const checks = []; let wpStatus = null;
    if(publicOnly)for(const kind of ['wp_access','wp_content','wp_status'])checks.push(check(kind,'not_applicable','Publication was verified in the native WordPress editor. This public-only check does not revalidate authenticated editor content.'));
    else {
    try {
      const found = await discover(base), auth = credentials(site);
      if (!found.apiRoot || !auth || !Number.isSafeInteger(page.wpId) || page.wpId < 1 || !['page','post'].includes(page.wpType || 'page')) {
        checks.push(check('wp_access','unknown','A verified REST endpoint, API credentials and a bound WordPress ID/type are required.'));
      } else {
        const response = await read(apiUrl(found.apiRoot,'/wp/v2/'+((page.wpType || 'page') === 'post' ? 'posts' : 'pages')+'/'+page.wpId,{context:'edit'}),auth,base.origin);
        const data = parseJSON(response), failure = authFailure(response);
        if (failure) checks.push(check('wp_access','problem','WordPress rejected authenticated access to this page.',failure));
        else if (good(response.status) && object(data) && data.id === page.wpId && object(data.content) && typeof data.content.raw === 'string') {
          checks.push(check('wp_access','ok','The bound WordPress page was read in edit context; no changes were sent.'));
          wpStatus = typeof data.status === 'string' ? data.status : null;
          if(page.remoteSnapshot&&typeof data.title?.raw==='string'&&wpStatus){const actual=snapshotHash([page.wpType||'page',data.title.raw,data.content.raw,wpStatus]);checks.push(check('wp_content',actual===page.remoteSnapshot.contentHash?'ok':'problem',actual===page.remoteSnapshot.contentHash?'The stored WordPress content matches the last committed PagePoster version.':'WordPress content, title or status changed since the last committed PagePoster version.'));}
        } else checks.push(check('wp_access','unknown','The API response did not verify edit access to the bound page. A WAF response or missing ID is not proof of deletion.'));
      }
    } catch (error) { checks.push(check('wp_access','unknown','WordPress access could not be checked.',errorCode(error))); }
    if(!checks.some(item=>item.kind==='wp_content'))checks.push(check('wp_content',page.remoteSnapshot?'unknown':'not_applicable','No complete authenticated snapshot is available for exact comparison.'));
    const statuses = ['publish','draft','pending','private','future','trash'];
    checks.push(check('wp_status',statuses.includes(wpStatus) ? (wpStatus === 'trash' ? 'problem' : 'ok') : 'unknown',statuses.includes(wpStatus) ? 'WordPress status: '+wpStatus+'.' : 'The WordPress publication state is unknown.'));
    }
    if (['draft','pending','private','future','trash'].includes(wpStatus)) {
      for (const kind of ['public','content','noindex','robots','links']) checks.push(check(kind,'not_applicable','This WordPress state does not require a public page; use authenticated preview verification.'));
      return KINDS.map(kind => checks.find(item => item.kind === kind));
    }
    let response;
    try { response = await read(pageUrl.href); }
    catch (error) {
      for (const kind of ['public','content','noindex','robots','links']) checks.push(check(kind,'unknown','The public response could not be checked.',errorCode(error)));
      return KINDS.map(kind => checks.find(item => item.kind === kind));
    }
    const sameOrigin = new URL(response.url).origin === base.origin;
    checks.push(check('public',good(response.status) && sameOrigin ? 'ok' : 'problem','Public HTTP '+response.status+(sameOrigin ? '.' : '; redirect left the registered site origin.'),sameOrigin ? undefined : 'cross_origin_redirect'));
    const htmlType = header(response,'content-type');
    if (!good(response.status) || !sameOrigin || (htmlType && !/text\/html|application\/xhtml\+xml/i.test(htmlType))) {
      for (const kind of ['content','noindex','links']) checks.push(check(kind,'unknown','A successful same-origin HTML page was not available.'));
    } else {
      const dom = doc(response.text);
      try {
        const document = dom.window.document;
        const expected=expectedHtmlFor(page),comparison=expected===null?null:comparePublishedContent(response.text,expected,{expectedMarker:page.expectedMarker||'pp-landing'});
        const links=linksCheck(document,response,page);
        if(comparison?.linksState==='problem'){links.state='problem';links.evidence=comparison.evidence+' [link_mismatch]';}
        checks.push(comparison?check('content',comparison.state,comparison.evidence,comparison.code==='content_verified'?undefined:comparison.code):markerCheck(document,page.expectedMarker),noindexCheck(document,response),links);
      } finally { dom.window.close(); }
    }
    if (!sameOrigin) checks.push(check('robots','unknown','Crawl rules were not verified after a cross-origin page redirect.'));
    else try {
      const robots = await read(new URL('/robots.txt',pageUrl).href);
      if ([404,410].includes(robots.status)) checks.push(check('robots','ok','robots.txt is absent (HTTP '+robots.status+'); no restriction was retrieved.'));
      else if (!good(robots.status)) checks.push(check('robots','unknown','robots.txt returned HTTP '+robots.status+'; crawl permission is not assumed.'));
      else {
        const addresses = new Set([pageUrl.href,response.url,...response.redirects.flatMap(hop => [hop.from,hop.to])]);
        const evaluations = [...addresses].map(address => new URL(address)).filter(url => url.origin === base.origin).map(url => robotsRules(robots.text,url));
        checks.push(evaluations.find(item => item.state === 'problem') || evaluations.find(item => item.state === 'unknown') || evaluations[0]);
      }
    } catch (error) { checks.push(check('robots','unknown','robots.txt could not be checked.',errorCode(error))); }
    return KINDS.map(kind => checks.find(item => item.kind === kind));
  }
  return { checkSite,checkPage };
}
