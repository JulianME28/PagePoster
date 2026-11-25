'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mod = import('../server/lifecycle/wordpress.mjs');
const SITE = { baseUrl: 'https://site.example/blog/', username: 'editor', applicationPassword: 'test-only-secret' };
const INDEX = { namespaces: ['wp/v2'], authentication: { 'application-passwords': { endpoints: { authorization: 'https://site.example/wp-admin/authorize-application.php' } } }, routes: { '/wp/v2/pages': { methods: ['GET','POST'] }, '/wp/v2/posts': { methods: ['GET','POST'] }, '/wp/v2/plugins': { methods: ['GET','POST'] } } };
function response(text, status = 200, headers = {}, url) { return { status, headers, text: typeof text === 'string' ? text : JSON.stringify(text), ...(url ? { url } : {}) }; }
function fixture(options = {}) {
  const calls = [];
  const root = options.query ? 'https://site.example/blog/?rest_route=/' : 'https://site.example/blog/wp-json/';
  const transport = async (url, init = {}) => {
    const address = new URL(url); calls.push({ url: String(url), ...init });
    const route = address.searchParams.get('rest_route') || address.pathname.replace('/blog/wp-json','');
    if (address.pathname === '/robots.txt') return response(options.robots ?? 'User-agent: *\nDisallow:\n', options.robotsStatus || 200, { 'content-type': 'text/plain' });
    if (route === '/wp/v2/users/me') return response(options.user ?? { id: 7, capabilities: { read: true, edit_pages: true, publish_pages: false, install_plugins: false, activate_plugins: false } }, options.authStatus || 200, { 'content-type': 'application/json' });
    if (route === '/wp/v2/plugins') return response(options.plugins ?? [{ plugin: 'pageposter-clean-links/pageposter-clean-links', status: 'active', version: '1.2.0' }], options.pluginsStatus || 200, { 'content-type': 'application/json' });
    if (route === '/wp/v2/pages/12' || route === '/wp/v2/posts/12') return response(options.page ?? { id: 12, status: 'publish', content: { raw: '<div id="pp-landing">our page</div>' }, modified_gmt: '2026-10-14T10:00:00' }, options.pageStatus || 200, { 'content-type': 'application/json' });
    if (String(url) === root) return response(options.index ?? INDEX, 200, { 'content-type': 'application/json' });
    if (address.pathname === '/blog/' && !address.search) return response('<html><head><meta name="generator" content="WordPress 6.8"><link rel="https://api.w.org/" href="'+root+'"></head></html>', 200, options.homeHeaders || {});
    if (address.pathname === '/blog/offer/') return response(options.html ?? '<html><head></head><body><div id="pp-landing"><h1>Our article</h1><a href="https://offer.example/go?offer=1&amp;src=x%2Fy#z">Offer</a><button data-pp-url="https://offer.example/go?offer=1&amp;src=x%2Fy#z">Again</button></div></body></html>', options.publicStatus || 200, { 'content-type': 'text/html', ...(options.publicHeaders || {}) }, options.finalUrl);
    return response({ code: 'rest_no_route' }, 404);
  };
  return { transport, calls, root };
}
const PAGE = { wpId: 12, wpType: 'page', fullUrl: 'https://site.example/blog/offer/', expectedMarker: 'pp-landing', expectedUrls: ['https://offer.example/go?offer=1&src=x%2Fy#z'] };
const get = (checks, kind) => checks.find(check => check.kind === kind);
test('site uses actual REST authentication and distinct capabilities, without inferring rights from an admin role', async () => {
  const { createWordPressClient } = await mod;
  const f = fixture({ user: { id: 7, roles: ['administrator'], capabilities: { read: true, edit_pages: true, publish_pages: false, install_plugins: false } } });
  const result = await createWordPressClient({ transport: f.transport }).checkSite(SITE);
  assert.equal(result.state, 'ok'); assert.equal(result.apiRoot, f.root);
  assert.equal(result.capabilities.read, true); assert.equal(result.capabilities.create, true);
  assert.equal(result.capabilities.publish, false); assert.equal(result.capabilities.install, false);
  assert.equal(result.plugins.cleanLinks.state, 'active');
  assert.equal(result.bootstrap.state, 'bootstrap_required'); assert.match(result.bootstrap.evidence, /ZIP|zip/);
  assert.ok(f.calls.some(call => call.url.includes('/users/me?context=edit') && call.headers.authorization.startsWith('Basic ')));
  assert.ok(f.calls.every(call => !call.method || call.method === 'GET'));
  assert.ok(!JSON.stringify(result).includes(SITE.applicationPassword));
});
test('discovery supports a WordPress subdirectory with rest_route and does not send credentials to the homepage', async () => {
  const { createWordPressClient } = await mod;
  const f = fixture({ query: true });
  const result = await createWordPressClient({ transport: f.transport }).checkSite(SITE);
  assert.equal(result.apiRoot, f.root); assert.equal(result.state, 'ok');
  assert.ok(f.calls.some(call => new URL(call.url).searchParams.get('rest_route') === '/wp/v2/users/me'));
  assert.equal(f.calls.find(call => call.url === SITE.baseUrl).headers?.authorization, undefined);
});
test('authentication errors and transport failures never reflect credentials or untrusted API error bodies', async () => {
  const { createWordPressClient } = await mod;
  const f = fixture({ authStatus: 401, user: { code: 'incorrect_password', message: SITE.applicationPassword } });
  const result = await createWordPressClient({ transport: f.transport }).checkSite(SITE);
  assert.equal(result.code, 'authentication_failed'); assert.equal(result.state, 'problem');
  assert.equal(result.capabilities.create, null); assert.ok(!JSON.stringify(result).includes(SITE.applicationPassword));
  const failed = await createWordPressClient({ transport: async () => { throw new Error(SITE.applicationPassword); } }).checkSite(SITE);
  assert.equal(failed.state, 'unknown'); assert.ok(!JSON.stringify(failed).includes(SITE.applicationPassword));
});
test('foreign discovery endpoints and authenticated redirects cannot masquerade as verified WordPress access', async () => {
  const { createWordPressClient } = await mod; const seen = [];
  const client = createWordPressClient({ transport: async (url, init) => {
    seen.push({url,init});
    if (url === SITE.baseUrl) return response('<link rel="https://api.w.org/" href="https://attacker.example/wp-json/">');
    if (url.includes('/users/me')) return response({ id: 7, capabilities: { install_plugins: true } }, 200, {}, 'https://attacker.example/fake');
    if (url.includes('wp-json') || url.includes('rest_route')) return response(INDEX);
    return response('',404);
  } });
  const result = await client.checkSite(SITE);
  assert.ok(!seen.some(call => call.url.includes('attacker.example')));
  assert.equal(result.state, 'unknown'); assert.notEqual(result.capabilities.install, true);
});
test('page monitoring separates public content, WP access, index directives, crawl rules and exact outgoing links', async () => {
  const { createWordPressClient } = await mod; const f = fixture();
  const checks = await createWordPressClient({ transport: f.transport }).checkPage({ site: SITE, page: PAGE });
  for (const kind of ['public','content','wp_access','wp_status','noindex','robots','links']) assert.equal(get(checks,kind)?.state, 'ok', kind);
  assert.match(get(checks,'links').evidence, /1/);
  assert.ok(f.calls.every(call => !call.method || call.method === 'GET'));
});
test('monitoring does not mistake missing markers, WAF pages or unavailable access for a deleted page', async () => {
  const { createWordPressClient } = await mod;
  const f = fixture({ html: '<html><h1>Checking your browser</h1></html>', pageStatus: 403, page: '<html>WAF challenge</html>' });
  const checks = await createWordPressClient({ transport: f.transport }).checkPage({ site: SITE, page: PAGE });
  assert.equal(get(checks,'content').state, 'problem');
  assert.equal(get(checks,'wp_access').state, 'unknown'); assert.equal(get(checks,'wp_status').state, 'unknown');
  assert.ok(!JSON.stringify(checks).includes('deleted'));
  const noMarker = await createWordPressClient({ transport: fixture().transport }).checkPage({ site: SITE, page: { ...PAGE, expectedMarker: undefined } });
  assert.equal(get(noMarker,'content').state, 'unknown');
});
test('noindex detects relevant meta tags and scoped or repeated HTTP headers without treating other bots as Googlebot', async () => {
  const { createWordPressClient } = await mod;
  for (const options of [
    { html: '<meta name="robots" content="index, noindex"><div id="pp-landing"></div>' },
    { html: '<meta name="GoogleBot" content="none"><div id="pp-landing"></div>' },
    { publicHeaders: { 'x-robots-tag': 'googlebot: noindex, nofollow' } },
    { publicHeaders: { 'x-robots-tag': ['otherbot: noindex','noindex'] } }
  ]) {
    const checks = await createWordPressClient({ transport: fixture(options).transport }).checkPage({ site: SITE, page: PAGE });
    assert.equal(get(checks,'noindex').state, 'problem');
  }
  const checks = await createWordPressClient({ transport: fixture({ publicHeaders: { 'x-robots-tag': 'googlebot: index, otherbot: noindex' } }).transport }).checkPage({ site: SITE, page: PAGE });
  assert.equal(get(checks,'noindex').state, 'ok');
});
test('robots rules choose Googlebot groups, longest matching path and allow on ties, with wildcard/end anchors', async () => {
  const { createWordPressClient } = await mod;
  for (const [robots,state] of [
    ['User-agent: *\nDisallow: /\nUser-agent: Googlebot\nAllow: /blog/', 'ok'],
    ['User-agent: Googlebot\nDisallow: /blog/\nUser-agent: Googlebot\nAllow: /blog/offer/', 'ok'],
    ['User-agent: *\nDisallow: /blog/offer/\nAllow: /blog/offer/', 'ok'],
    ['User-agent: *\nDisallow: /*offer/$', 'problem'],
    ['User-agent: *\nDisallow: /*offer$', 'ok'],
    ['User-agent: *\nDisallow: /blog/offer/\nAllow: /blog/', 'problem'],
    ['<html>captcha challenge</html>', 'unknown'],
    ['User-agent: *\nDisallow: bad-path', 'unknown']
  ]) {
    const checks = await createWordPressClient({ transport: fixture({ robots }).transport }).checkPage({ site: SITE, page: PAGE });
    assert.equal(get(checks,'robots').state, state, robots);
  }
});
test('robots network errors remain unknown and a missing robots file does not imply noindex', async () => {
  const { createWordPressClient } = await mod;
  for (const [robotsStatus,state] of [[404,'ok'],[429,'unknown'],[503,'unknown']]) {
    const checks = await createWordPressClient({ transport: fixture({ robotsStatus }).transport }).checkPage({ site: SITE, page: PAGE });
    assert.equal(get(checks,'robots').state, state); assert.equal(get(checks,'noindex').state, 'ok');
  }
});
test('outbound audit preserves query encoding, decodes HTML entities once and detects missing, duplicate and extra addresses', async () => {
  const { createWordPressClient } = await mod;
  for (const html of [
    '<a href="https://offer.example/go?offer=1&amp;src=x%2Fy#z">yes</a><a href="https://offer.example/go?offer=1&amp;src=x%2Fy#z">duplicate</a>',
    '<a href="https://offer.example/go?offer=1&amp;src=x%2fy#z">encoding changed</a>',
    '<a href="https://offer.example/go?offer=1&amp;src=x%2Fy#z">yes</a><a href="https://other.example/">extra</a>',
    '<a href="https://offer.example/go?offer=1&amp;amp;src=x%2Fy#z">not decoded twice</a>'
  ]) {
    const checks = await createWordPressClient({ transport: fixture({ html: '<div id="pp-landing">'+html+'</div>' }).transport }).checkPage({ site: SITE, page: PAGE });
    assert.equal(get(checks,'links').state, 'problem', html);
  }
});
test('drafts have no public indexing requirement and foreign page inputs do not claim verified ownership', async () => {
  const { createWordPressClient } = await mod;
  const f = fixture({ page: { id: 12, status: 'draft', content: { raw: 'draft' } }, publicStatus: 404 });
  const checks = await createWordPressClient({ transport: f.transport }).checkPage({ site: SITE, page: PAGE });
  assert.equal(get(checks,'wp_status').state, 'ok');
  for (const kind of ['public','noindex','robots']) assert.equal(get(checks,kind).state, 'not_applicable');
  const foreign = fixture();
  const wrong = await createWordPressClient({ transport: foreign.transport }).checkPage({ site: SITE, page: { ...PAGE, fullUrl: 'https://elsewhere.example/page' } });
  assert.equal(get(wrong,'public').state, 'problem'); assert.equal(foreign.calls.length, 0);
});

test('robots matching is bounded for hostile wildcard inputs and preserves encoded reserved-path boundaries', async () => {
  const { createWordPressClient } = await mod;
  for (const [robots,state] of [
    ['User-agent: *\nDisallow: /blog/%6Fffer/', 'problem'],
    ['User-agent: *\nDisallow: /blog%2Foffer/', 'ok'],
    ['User-agent: *\nDisallow: /blog/offer/?q=1$', 'ok'],
    ['User-agent: *\nDisallow: /'+('a'.repeat(8193)), 'unknown']
  ]) {
    const checks = await createWordPressClient({ transport: fixture({ robots }).transport }).checkPage({ site: SITE, page: PAGE });
    assert.equal(get(checks,'robots').state, state);
  }
});
test('HTML base destinations and script-only marker IDs cannot produce false verification', async () => {
  const { createWordPressClient } = await mod;
  const f = fixture({ html: '<base href="https://extra.example/"><script id="pp-landing"></script><a href="/hidden">Hidden outgoing</a><a href="https://offer.example/go?offer=1&amp;src=x%2Fy#z">Offer</a>' });
  const checks = await createWordPressClient({ transport: f.transport }).checkPage({ site: SITE, page: PAGE });
  assert.equal(get(checks,'content').state, 'problem');
  assert.equal(get(checks,'links').state, 'problem');
});
test('missing capability data, unavailable plugin list and a discovered Bridge do not invent privileges', async () => {
  const { createWordPressClient } = await mod;
  const f = fixture({ user: { id: 7, roles: ['administrator'] }, pluginsStatus: 403, plugins: { code: 'rest_cannot_view_plugins' }, index: {...INDEX,namespaces:['wp/v2','pageposter-bridge/v1']} });
  const result = await createWordPressClient({ transport: f.transport }).checkSite(SITE);
  assert.equal(result.capabilities.install, null);
  assert.equal(result.plugins.cleanLinks.state, 'unknown');
  assert.equal(result.plugins.bridge.state, 'discovered');
  assert.equal(result.bootstrap.state, 'bootstrap_required');
});

test('robots checks include the requested URL before a same-origin redirect', async () => {
  const { createWordPressClient } = await mod;
  const checks = await createWordPressClient({ transport: fixture({ finalUrl:'https://site.example/blog/public/',robots:'User-agent: *\nDisallow: /blog/offer/' }).transport }).checkPage({site:SITE,page:PAGE});
  assert.equal(get(checks,'robots').state,'problem');
});

test('page check results keep bounded fields and optional structured failure codes', async () => {
  const { createWordPressClient } = await mod;
  const checks = await createWordPressClient({transport:fixture({html:'<h1>Missing expected content</h1>',robots:'User-agent: *\nDisallow: /'}).transport}).checkPage({site:SITE,page:PAGE});
  for (const row of checks) {
    assert.deepEqual(Object.keys(row).sort(),row.code===undefined?['evidence','kind','state']:['code','evidence','kind','state']);
    if(row.code!==undefined)assert.match(row.code,/^[a-z][a-z0-9_]{0,63}$/);
    assert.equal(typeof row.evidence,'string');
  }
  assert.equal(get(checks,'content').code,'content_mismatch');
  assert.equal(get(checks,'robots').code,'crawl_disallowed');
});

test('current Bridge namespace is discoverable even when listing installed plugins is forbidden',async()=>{
  const {createWordPressClient}=await mod;
  const f=fixture({pluginsStatus:403,index:{...INDEX,namespaces:['wp/v2','pageposter/v1']}});
  const result=await createWordPressClient({transport:f.transport}).checkSite(SITE);
  assert.equal(result.plugins.bridge.state,'discovered');
  assert.equal(result.bootstrap.state,'bootstrap_required');
});
test('authenticated source monitoring detects manual edits even when the public cache is unchanged',async()=>{
 const {createWordPressClient}=await mod;const {bridgeContentHash}=await import('../server/lifecycle/bridge-client.mjs');
 const snapshot={postType:'page',title:'Article',content:'<div id="pp-landing">Original</div>',status:'publish'};
 const page={...PAGE,remoteSnapshot:{...snapshot,contentHash:bridgeContentHash(snapshot)}};
 const remote={id:12,type:'page',status:'publish',title:{raw:'Article'},content:{raw:snapshot.content}};
 const unchanged=await createWordPressClient({transport:fixture({page:remote}).transport}).checkPage({site:SITE,page});assert.equal(get(unchanged,'wp_content').state,'ok');
 const changed=await createWordPressClient({transport:fixture({page:{...remote,content:{raw:snapshot.content+'Manual edit'}}}).transport}).checkPage({site:SITE,page});assert.equal(get(changed,'wp_content').state,'problem');assert.equal(get(changed,'content').state,'problem');
});
test('plugin inventory separates activation from required package compatibility',async()=>{
 const {createWordPressClient}=await mod,f=fixture({plugins:[{plugin:'pageposter-bridge/pageposter-bridge',status:'active',version:'0.1.0'},{plugin:'pageposter-clean-links/pageposter-clean-links',status:'active',version:'1.1.0'}]});const result=await createWordPressClient({transport:f.transport}).checkSite(SITE);assert.equal(result.plugins.bridge.compatible,false);assert.equal(result.plugins.bridge.requiredVersion,'0.2.1');assert.equal(result.plugins.cleanLinks.compatible,false);assert.equal(result.plugins.cleanLinks.requiredVersion,'1.1.1');assert.equal(result.bootstrap.state,'update_required');
});
