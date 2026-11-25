'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {once}=require('node:events'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {createLocalServer}=require('../server/local.cjs');
const {JSDOM}=require('jsdom');
const API_KEY='sk-fixture_autopilot_http_no_network_123456789';
const ADMIN_PASSWORD='fixture-wordpress-admin-secret',APPLICATION_PASSWORD='fixture-wordpress-api-secret';
const links=[{url:'https://destination.example/go?offer=21&encoded=%2f#Keep',anchor:'Porównaj oferty | dokładny [tekst]'},{url:'https://destination.example/second?b=2&a=1',anchor:'Sprawdź warunki'}];
const paragraph='Przeczytaj informacje na stronie docelowej i porównaj warunki przed podjęciem decyzji. Zwróć uwagę na zakres oferty, sposób kontaktu oraz dokumenty udostępnione przez operatora. Zachowaj własną listę pytań, aby spokojnie przeanalizować dostępne informacje.';
function completePage(input){
 return {language:'pl',topic:'Porównanie ofert',title:'Świadomy wybór: praktyczny przewodnik po ofertach',brand:'Przewodnik wyboru',brandTagline:'Praktyczne informacje',intro:paragraph,cardsTitle:'Poznaj dostępne strony',articleTitle:'Praktyczny przewodnik',faqTitle:'Pytania i odpowiedzi',footerTitle:'O przewodniku',footer:'Informacyjny przewodnik pomagający uporządkować pytania przed wyborem.',footerLinksTitle:'Przejdź do części',footerNote:'Treść informacyjna. Odnośniki mogą być partnerskie.',ctaLabel:'Sprawdź szczegóły',tocTitle:'Spis treści',tableTitle:'Lista pytań',tableText:'Kryterium | Co sprawdzić\nKontakt | Dostępne kanały\nWarunki | Aktualny regulamin',design:{preset:'rose',fontFamily:'Georgia',colors:{background:'#faf8fc',accent:'#daafed',header:'#241535',card:'#403049'}},offers:input.links.map((link,index)=>({linkIndex:index,description:'Przeczytaj aktualne szczegóły i warunki na stronie docelowej.',button:'Sprawdź szczegóły'})),sections:Array.from({length:6},(_,index)=>({title:'Część przewodnika '+(index+1),body:paragraph})),faq:Array.from({length:4},(_,index)=>({question:'Co sprawdzić przed wyborem '+(index+1)+'?',answer:paragraph})),navLabels:{offers:'Strony',guide:'Przewodnik',faq:'Pytania'},linkSentences:Object.fromEntries(input.links.map(link=>[link.sentenceKey,{before:'Przeczytaj ',after:' przed wyborem.'}]))};
}

test('real local HTTP links-only launch generates, restarts, installs and publishes exactly once with durable AI budget', {timeout:30000}, async t=>{
 const {bridgeContentHash}=await import('../server/lifecycle/bridge-client.mjs');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'pp-autopilot-http-')),dataDir=path.join(temporary,'data');
 const calls=[],writes=[],bootstrapCalls=[],sourceCalls=[],checks=[];let server,origin;
 const sourceConfig={spreadsheetId:'fixtureGoogleSheet12345',range:'Sites!A1:D100',serviceAccount:{client_email:'test@fixture.iam.gserviceaccount.com',private_key:'-----BEGIN PRIVATE KEY-----fixture-----END PRIVATE KEY-----'},columns:{url:'A',username:'B',password:'C',enabled:'D'}};
 const source={pickUnused:async(config,used)=>{sourceCalls.push({used});assert.equal(config.spreadsheetId,sourceConfig.spreadsheetId);return {id:'fixture-row-2',baseUrl:'https://fixture-wordpress.example/',username:'fixture-user',password:ADMIN_PASSWORD,rowNumber:2};}};
 const bootstrapFactory=({checkpoint})=>({ensureReady:async input=>{bootstrapCalls.push(input.operationId);assert.equal(input.password,ADMIN_PASSWORD);await checkpoint({stage:'credential_created',credential:{username:'fixture-user',applicationPassword:APPLICATION_PASSWORD}});return {state:'ready',username:'fixture-user',applicationPassword:APPLICATION_PASSWORD};}});
 const bridge={checkStatus:async()=>({ready:true,integrityVerified:true,integrity:{bridge:true,cleanLinks:true}}),submitOperation:async({site,operation,beforeSend})=>{
  beforeSend?.();assert.equal(site.applicationPassword,APPLICATION_PASSWORD);writes.push(operation);
  return {state:'completed',operationId:operation.operationId,postId:101,postType:operation.postType,status:operation.status,contentHash:bridgeContentHash(operation),url:'https://fixture-wordpress.example/generated-page/'};
 }};
 const runtime={
  dataDir,keyDir:path.join(temporary,'keys'),masterKey:Buffer.alloc(32,31).toString('base64'),workerIntervalMs:3600000,bridgeClient:bridge,autopilotOptions:{source,bootstrapFactory},
  browserVerifier:{verifyGenerated:async({html})=>{assert.match(html,/id="pp-landing"/);return {layoutState:'ok',viewports:[]};},verifyPublished:async()=>({state:'ok',viewports:[],evidence:{fixture:true}})},
  client:{checkSite:async()=>({state:'ok',apiRoot:'https://fixture-wordpress.example/wp-json/',capabilities:{publishPages:true},plugins:{bridge:{compatible:true},cleanLinks:{compatible:true}}}),checkPage:async({page})=>{checks.push(page.fullUrl);return ['public','content','wp_access','wp_status','wp_content','noindex','robots','links'].map(kind=>({kind,state:'ok',evidence:'Fixture WordPress result'}));}}
 };
 const provider=async(url,options)=>{
  assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(options.headers.Authorization,'Bearer '+API_KEY);
  for(const secret of [API_KEY,ADMIN_PASSWORD,APPLICATION_PASSWORD])assert.ok(!options.body.includes(secret));
  const body=JSON.parse(options.body),input=JSON.parse(body.input);calls.push({body,input});
  assert.equal(input.contract,'pageposter-autopage-v2');assert.equal(body.text.format.name,'pageposter_complete_page');assert.equal(body.text.format.strict,true);
  assert.deepEqual(input.links.map(link=>({url:link.destination,anchor:link.anchor})),links);
  return new Response(JSON.stringify({status:'completed',usage:{input_tokens:500,output_tokens:1200},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(completePage(input))}]}]}));
 };
 async function open(){server=await createLocalServer({env:{},fetchImpl:provider,lifecycle:runtime});server.listen(0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+server.address().port;}
 async function close(){if(!server)return;const current=server;server=null;await new Promise(resolve=>{current.close(resolve);current.closeAllConnections();});await current.closeResources();}
 async function request(route,body){const response=await fetch(origin+route,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json','X-PagePoster-Request':'1'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});const text=await response.text();for(const secret of [API_KEY,ADMIN_PASSWORD,APPLICATION_PASSWORD])assert.ok(!text.includes(secret));return {status:response.status,...JSON.parse(text)};}
 t.after(async()=>{await close();assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir())+path.sep+'pp-autopilot-http-'));fs.rmSync(temporary,{recursive:true,force:true});});
 await open();
 assert.equal((await request('/api/ai/connect',{apiKey:API_KEY})).status,200);
 const projectResult=await request('/api/lifecycle/projects',{name:'Links-only HTTP project'});assert.equal(projectResult.status,201);const projectId=projectResult.project.id;
 assert.equal((await request('/api/lifecycle/autopilot/source',sourceConfig)).status,200);
 const launchBody={idempotencyKey:randomUUID(),links},launchRoute='/api/lifecycle/projects/'+projectId+'/autopilot';
 const launched=await request(launchRoute,launchBody);assert.equal(launched.status,202);assert.equal(calls.length,0);
 assert.equal((await request(launchRoute,launchBody)).run.id,launched.run.id);
 await server.lifecycle.tick();
 const afterGeneration=(await request(launchRoute)).runs[0];assert.equal(afterGeneration.stage,'selecting');assert.equal(calls.length,1);assert.equal(writes.length,0);
 const html=(await request('/api/lifecycle/autopilot/'+launched.run.id+'/html')).html;
 const document=new JSDOM(html).window.document;
 assert.match(document.querySelector('h1').textContent,/Świadomy wybór/);assert.equal(document.querySelectorAll('.pp-prose[id^="pp-section-"]').length,6);assert.equal(document.querySelectorAll('.pp-faq-item').length,4);
 for(const link of links){assert.equal([...document.querySelectorAll('a[href]')].filter(a=>a.getAttribute('href')===link.url).length,1);assert.ok(document.body.textContent.includes(link.anchor));}
 assert.ok(document.querySelectorAll('[data-pp-url]').length>=4);assert.match(html,/#daafed/);
 let budget=(await request('/api/ai/status')).budget;assert.equal(budget.counts.completed,1);assert.equal(budget.spentTokens,1700);
 // The same encrypted key and persisted generated config survive a full HTTP-server restart.
 await close();await open();
 let run;
 for(let attempt=0;attempt<16;attempt++){await server.lifecycle.tick();run=(await request(launchRoute)).runs[0];if(['completed','failed','needs_attention','uncertain'].includes(run.state))break;}
 assert.equal(run.state,'completed',JSON.stringify(run));assert.equal(run.fullUrl,'https://fixture-wordpress.example/generated-page/');
 assert.equal(calls.length,1);assert.equal(sourceCalls.length,1);assert.equal(bootstrapCalls.length,1);assert.equal(writes.length,1);assert.equal(checks.length,1);
 assert.equal(writes[0].title,document.querySelector('h1').textContent);assert.equal(writes[0].status,'publish');assert.equal(writes[0].postType,'page');
 const saved=(await request('/api/lifecycle/pages/'+run.pageId)).page;
 assert.equal(saved.config.designVariant.source,'ai');assert.equal(saved.config.fontFamily,'Georgia');assert.equal(saved.config.language,'pl');assert.equal(saved.verification.state,'ok');
 assert.equal((await request(launchRoute,launchBody)).run.id,run.id);
 assert.equal((await request(launchRoute,{...launchBody,links:[{...links[0],anchor:'Changed anchor'}]})).status,409);
 // Replaying the actual public AI endpoint proves its durable response receipt is reused.
 const replay=await request('/api/ai/page',{requestId:run.id+'-page',links,variation:run.id});
 assert.equal(replay.status,200);assert.equal(replay.config.title,saved.config.title);assert.equal(calls.length,1);
 budget=(await request('/api/ai/status')).budget;assert.equal(budget.counts.completed,1);assert.equal(budget.spentTokens,1700);
 await server.lifecycle.tick();assert.equal(writes.length,1);
});

