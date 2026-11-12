const http = require('node:http');
const {timingSafeEqual}=require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pathToFileURL } = require('node:url');
const root = path.join(__dirname,'..','dist');
const assetNames = new Set(['index.html','autopilot.html','autopilot.css','autopilot-ui.js','autopilot-recovery.js','project-queue-ui.js','project-queue.css','proxy-settings-ui.js','proxy-check-ui.js','workspace-ui.js','workspace.css','google-account-ui.js','google-account.css','styles.css','purify.min.js','csstree.js','html-import.js','html-package.js','project-table.js','project-normalizer.js','page-runtime.js','generator.js','link-placements.js','design-variants.js','app.js','ai-core.js','ai-ui.js','plugin-download.js','run-ui.js','campaign-ui.js','lifecycle-ui.js','lifecycle.css','PagePoster.html']);
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8'};
async function createLocalServer({env=process.env,fetchImpl=globalThis.fetch,lifecycle: lifecycleOptions}={}) {
  const {createAIHandler} = await import(pathToFileURL(path.join(__dirname,'ai.mjs')).href);
  let budget=null;
  const runtimeEnv = {...env};
  const accessToken=env.PAGEPOSTER_ACCESS_TOKEN||'';if(accessToken&&(typeof accessToken!=='string'||accessToken.length<32||accessToken.length>512||/[\r\n:]/.test(accessToken)))throw Error('Invalid private runtime token');
  const expectedAuth=accessToken?Buffer.from('Basic '+Buffer.from('pageposter:'+accessToken).toString('base64')):null;
  let publicOrigin=null;if(env.PAGEPOSTER_PUBLIC_ORIGIN){const u=new URL(env.PAGEPOSTER_PUBLIC_ORIGIN);if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash||!expectedAuth)throw Error('Private HTTPS origin and token required');publicOrigin=u.origin;}
  let lifecycle=null;let masterKey=null;let keyVault=null;
  if(lifecycleOptions){
    const {createLifecycleService}=await import('./lifecycle/service.mjs');
    const {loadMasterKey}=await import('./lifecycle/keyring.mjs');
    masterKey=await loadMasterKey({provided:lifecycleOptions.masterKey||env.PAGEPOSTER_MASTER_KEY,directory:lifecycleOptions.keyDir||path.join(lifecycleOptions.dataDir,'..','keys')});
    const {createAIBudget}=await import('./lifecycle/ai-budget.mjs');
    budget=createAIBudget({filename:path.join(lifecycleOptions.dataDir,'ai-budget.sqlite'),monthlyUSD:Number(env.PAGEPOSTER_AI_MONTHLY_USD??10),monthlyTokens:Number(env.PAGEPOSTER_AI_MONTHLY_TOKENS??2000000),...(env.PAGEPOSTER_AI_RATES?{rates:JSON.parse(env.PAGEPOSTER_AI_RATES)}:{})});
  }
  if(lifecycleOptions&&masterKey){const {createAPIKeyVault}=await import('./lifecycle/api-key.mjs');keyVault=createAPIKeyVault({filename:path.join(lifecycleOptions.dataDir,'openai-key.json'),masterKey});if(!runtimeEnv.OPENAI_API_KEY)runtimeEnv.OPENAI_API_KEY=await keyVault.read();}
  const {pagePlannerContracts}=await import('./lifecycle/ai-page-planner.mjs');
  const {projectColumnContract}=await import('./lifecycle/project-column-ai.mjs');
  const handleAI=createAIHandler({fetchImpl,budget,contracts:{...pagePlannerContracts,...(budget?{'/api/ai/project-columns':projectColumnContract}:{})}});
  if(lifecycleOptions){const {createLifecycleService}=await import('./lifecycle/service.mjs');lifecycle=await createLifecycleService({...lifecycleOptions,masterKey,ai:{handler:handleAI,env:runtimeEnv,budget}});}
  const inFlight=new Set();let recoveryBusy=false,restartRequired=false;
  const handleRequest=async (req,res)=>{
    if(expectedAuth){const provided=Buffer.from(String(req.headers.authorization||''));if(provided.length!==expectedAuth.length||!timingSafeEqual(provided,expectedAuth)){res.writeHead(401,{'WWW-Authenticate':'Basic realm="PagePoster", charset="UTF-8"','Cache-Control':'no-store'});res.end('PagePoster sign in required');return;}}
    const port=serverPort(req), host=req.headers.host;
    if (!host || !['127.0.0.1:'+port,'localhost:'+port,...(publicOrigin?[new URL(publicOrigin).host]:[])].includes(host)) {res.writeHead(403);res.end('Forbidden host');return;}
    let url;try{url=new URL(req.url,publicOrigin&&host===new URL(publicOrigin).host?publicOrigin:'http://'+host);}catch{res.writeHead(400);res.end('Bad request');return;}
    if(url.pathname.startsWith('/api/')&&recoveryBusy&&!url.pathname.startsWith('/api/recovery/')){res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({code:'RECOVERY_BUSY',error:restartRequired?'Відновлення завершено. Перезапусти PagePoster.':'Триває створення або відновлення копії. Спробуй за хвилину.'}));return;}
    if(url.pathname.startsWith('/api/')) {
      const controller=new AbortController();
      const cancel=()=>{if(!res.writableEnded)controller.abort();};
      req.on('aborted',cancel);res.on('close',cancel);
      try {
        const request=new Request(url,{method:req.method,headers:req.headers,signal:controller.signal,...(!['GET','HEAD'].includes(req.method)?{body:Readable.toWeb(req),duplex:'half'}:{})});
        let result;
        if(url.pathname.startsWith('/api/recovery/'))result=await recoveryRequest(request);
        else if(url.pathname.startsWith('/api/lifecycle/'))result=lifecycle?await lifecycle.handle(request):localJson({available:false,runtime:'editor',credentialStorage:false,monitoring:{enabled:false},publication:false,message:'Запусти локальний сервер PagePoster для проєктів і моніторингу.'},url.pathname==='/api/lifecycle/status'?200:503);
        else if(url.pathname==='/api/ai/connect')result=await connectLocalKey(request,runtimeEnv,keyVault);
        else if(url.pathname==='/api/ai/status' && req.method==='GET')result=localJson({configured:!!runtimeEnv.OPENAI_API_KEY?.trim(),model:runtimeEnv.OPENAI_MODEL||'gpt-5.4-mini',keyEntryAllowed:true,keyPersistent:!!keyVault,budget:budget?.status()||null});
        else result=await handleAI(request,runtimeEnv);
        if(!res.destroyed){res.writeHead(result.status,Object.fromEntries(result.headers));res.end(Buffer.from(await result.arrayBuffer()));}
      }catch{if(!res.destroyed){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Не вдалося обробити запит. Чернетку не змінено.'}));}}
      finally{req.off('aborted',cancel);res.off('close',cancel);}
      return;
    }
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end('Method not allowed');return;}
    const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
    if(!assetNames.has(name)){res.writeHead(404);res.end('Not found');return;}
    fs.readFile(path.join(root,name),(error,buffer)=>{
      if(error){res.writeHead(404);res.end('Not found');return;}
      res.writeHead(200,{'Content-Type':types[path.extname(name)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      res.end(req.method==='HEAD'?undefined:buffer);
    });
  };
  const server=http.createServer((req,res)=>{const isRecovery=/^\/api\/recovery\//.test(req.url||'');const work=handleRequest(req,res);if(!isRecovery){inFlight.add(work);work.finally(()=>inFlight.delete(work));}work.catch(()=>{if(!res.headersSent)res.writeHead(500);res.end();});});
  async function recoveryRequest(request){
    const url=new URL(request.url);if(request.method!=='POST'||request.headers.get('origin')!==url.origin||request.headers.get('X-PagePoster-Request')!=='1'||request.headers.get('sec-fetch-site')==='cross-site')return localJson({error:'Відкрий PagePoster у його власній вкладці.'},403);
    if(!lifecycle||!masterKey)return localJson({code:'KEY_REQUIRED',error:'Захищене сховище не налаштовано.'},400);
    if(recoveryBusy)return localJson({code:'RECOVERY_BUSY',error:'Інша операція з копією ще триває.'},409);
    recoveryBusy=true;let resume;const action=url.pathname.split('/').at(-1);
    try{
      const body=await recoveryInput(request);if(!['export','inspect','restore'].includes(action)||Object.keys(body).some(k=>!['passphrase','backup','confirmed'].includes(k)))return localJson({code:'VALIDATION',error:'Невідомий запит копії.'},400);
      const recovery=await import('./lifecycle/full-recovery.mjs');
      await Promise.allSettled([...inFlight]);resume=await lifecycle.quiesce();
      const options={dataDir:lifecycleOptions.dataDir,masterKey,passphrase:body.passphrase,backup:body.backup};
      if(action==='export')return localJson(await recovery.exportFullBackup(options));
      if(action==='inspect')return localJson(await recovery.inspectFullBackup(options));
      if(body.confirmed!==true)return localJson({code:'VALIDATION',error:'Спочатку переглянь і підтвердь відновлення.'},400);
      const inspected=await recovery.inspectFullBackup(options);if(!inspected.canRestore)return localJson({code:'RESTORE_NOT_EMPTY',error:'Відновлення доступне лише у порожню базу.'},409);
      await server.closeResources();restartRequired=true;const result=await recovery.restoreFullBackup(options);return localJson(result);
    }catch(error){const messages={BACKUP_PASSWORD_INVALID:'Неправильний пароль, пошкоджена копія або пароль коротший за 12 символів.',BACKUP_INVALID:'Файл не є сумісною повною копією PagePoster.',BACKUP_TOO_LARGE:'Повна копія перевищує ліміт 512 МіБ даних або 150 МіБ зашифрованого файлу. Розмір включає базу, історію версій і скриншоти.',RESTORE_NOT_EMPTY:'Відновлення доступне лише у порожню базу.'};return localJson({code:messages[error.code]?error.code:'BACKUP_FAILED',error:messages[error.code]||'Не вдалося завершити операцію. Робочі дані не перезаписано.'},400);}
    finally{if(!restartRequired){resume?.();recoveryBusy=false;}}
  }
  server.lifecycle=lifecycle;server.aiBudget=budget;
  server.once('listening',()=>lifecycle?.start());
  let closePromise=null;server.closeResources=()=>closePromise||(closePromise=Promise.resolve(lifecycle?.close()).finally(()=>budget?.close()));
  server.once('close',()=>{server.closeResources().catch(()=>{});});
  return server;
}
function localJson(value,status=200){return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
async function connectLocalKey(request,runtimeEnv,keyVault){
  if(request.method!=='POST')return localJson({error:'Потрібний POST-запит.'},405);
  if(request.headers.get('origin')!==new URL(request.url).origin)return localJson({error:'Відкрий локальний редактор у його власній вкладці.'},403);
  if(!/^application\/json(?:;|$)/i.test(request.headers.get('content-type')||''))return localJson({error:'Потрібний формат JSON.'},415);
  let size=0;const parts=[];const reader=request.body?.getReader();
  if(!reader)return localJson({error:'Порожній запит.'},400);
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4096){await reader.cancel();return localJson({error:'Завеликий запит.'},413);}parts.push(value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
  let input;try{input=JSON.parse(new TextDecoder().decode(bytes));}catch{return localJson({error:'Не вдалося прочитати ключ.'},400);}
  if(!input||typeof input.apiKey!=='string')return localJson({error:'Введи ключ OpenAI API.'},400);
  const key=input.apiKey.trim();
  if(key && !/^sk-[A-Za-z0-9_-]{17,509}$/.test(key))return localJson({error:'Перевір формат ключа OpenAI API.'},400);
  if(keyVault)await keyVault.write(key);
  runtimeEnv.OPENAI_API_KEY=key;
  return localJson({configured:!!key,model:runtimeEnv.OPENAI_MODEL||'gpt-5.4-mini',keyEntryAllowed:true,keyPersistent:!!keyVault});
}
// A 150 MiB archive needs room for the JSON request envelope and passphrase.
async function recoveryInput(request){if(!/^application\/json(?:;|$)/i.test(request.headers.get('content-type')||''))throw Error('Invalid request');const max=151*1024*1024,tooLarge=()=>Object.assign(Error('Too large'),{code:'BACKUP_TOO_LARGE'});if(Number(request.headers.get('content-length'))>max)throw tooLarge();const reader=request.body?.getReader();if(!reader)throw Error('Empty request');let size=0,parts=[];try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();throw tooLarge();}parts.push(value);}}finally{reader.releaseLock();}const body=JSON.parse(Buffer.concat(parts).toString('utf8'));if(!body||typeof body!=='object'||Array.isArray(body))throw Error('Invalid request');return body;}
function serverPort(req){return req.socket.localPort;}
module.exports={createLocalServer};
