const fs=require('node:fs');
const path=require('node:path');
const root=__dirname;
const read=name=>fs.readFileSync(path.join(root,name),'utf8').replace(/^\uFEFF/,'');
const assets={};
for(const name of ['index.html','autopilot.html','autopilot.css','autopilot-ui.js','autopilot-recovery.js','project-queue.css','project-queue-ui.js','google-account-ui.js','google-account.css','proxy-settings-ui.js','proxy-check-ui.js','workspace-ui.js','workspace.css','styles.css','purify.min.js','csstree.js','html-import.js','html-package.js','project-table.js','project-normalizer.js','generation-options.js','page-runtime.js','generator.js','link-placements.js','design-variants.js','ai-core.js','ai-ui.js','plugin-download.js','run-ui.js','campaign-ui.js','lifecycle-ui.js','lifecycle.css','app.js','PagePoster.html']){
  const type=name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8';
  assets[name]={body:read('dist/'+name),type};
}
const quality='const {normalizeFacts,resolveFactReferences,inspectContentQuality}=(()=>{'+read('server/content-quality.mjs').replace(/^export /gm,'')+';return {normalizeFacts,resolveFactReferences,inspectContentQuality};})();';
const diagnostics='const {providerFailure}=(()=>{'+read('server/ai-diagnostics.mjs').replace(/^export /gm,'')+';return {providerFailure};})();';
const api=read('server/ai.mjs').replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'');
const worker=read('worker/index.mjs').replace(/^import .*;\r?\n/m,'');
const output='const PAGEPOSTER_ASSETS='+JSON.stringify(assets)+';\n'+quality+'\n'+diagnostics+'\n'+api+'\n'+worker;
fs.mkdirSync(path.join(root,'dist/server'),{recursive:true});
fs.mkdirSync(path.join(root,'dist/.openai'),{recursive:true});
fs.writeFileSync(path.join(root,'dist/server/index.js'),output,'utf8');
if(fs.existsSync(path.join(root,'.openai/hosting.json')))fs.copyFileSync(path.join(root,'.openai/hosting.json'),path.join(root,'dist/.openai/hosting.json'));
(async()=>{
 const module=await import('data:text/javascript;base64,'+Buffer.from(output).toString('base64'));
 if(typeof module.default?.fetch!=='function')throw new Error('Invalid Worker export');
 const page=await module.default.fetch(new Request('https://pageposter.test/'),{},{});
 if(page.status!==200 || !(await page.text()).includes('autopilot-ui.js'))throw new Error('Missing UI assets');
 const status=await module.default.fetch(new Request('https://pageposter.test/api/ai/status'),{},{});
 if((await status.json()).configured!==false)throw new Error('Unexpected embedded key');
 console.log('Hosted Worker built and verified: '+output.length+' bytes');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
