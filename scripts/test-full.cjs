'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..');
async function browserPreflight(){
 const explicitModule=process.env.PAGEPOSTER_PLAYWRIGHT_MODULE,candidates=explicitModule?[explicitModule]:['playwright',path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')];
 let playwrightPath,playwright;
 for(const candidate of candidates){try{const resolved=require.resolve(candidate,{paths:[root]});const value=require(resolved);if(value.chromium?.launch){playwrightPath=resolved;playwright=value;break;}}catch{}}
 if(!playwright)throw Error('Full tests require Playwright. Install it or set PAGEPOSTER_PLAYWRIGHT_MODULE to its module path.');
 const explicitChrome=process.env.PAGEPOSTER_CHROME,browsers=explicitChrome?[explicitChrome]:[playwright.chromium.executablePath(),path.join(process.env.ProgramFiles||'C:/Program Files','Google/Chrome/Application/chrome.exe'),'/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
 const chrome=browsers.find(candidate=>{try{return fs.statSync(candidate).isFile();}catch{return false;}});
 if(!chrome)throw Error('Full tests require Chrome/Chromium. Install a browser or set PAGEPOSTER_CHROME to its executable path.');
 let browser;try{browser=await playwright.chromium.launch({executablePath:chrome,headless:true,args:['--no-first-run','--disable-background-networking'],timeout:15000});}catch{throw Error('Chrome/Chromium could not start. Check its executable and system dependencies before running full tests.');}finally{await browser?.close();}
 return {ready:true,playwright:playwrightPath,chrome:path.resolve(chrome)};
}
async function main(){
 if(process.argv.slice(2).some(arg=>arg!=='--preflight-only'))throw Error('Usage: node scripts/test-full.cjs [--preflight-only]');
 const browser=await browserPreflight();if(process.argv.includes('--preflight-only')){console.log(JSON.stringify(browser));return;}
 const child=spawn(process.execPath,['--test','--test-concurrency=2','--test-reporter=tap','tests/*.test.cjs'],{cwd:root,env:{...process.env,PAGEPOSTER_PLAYWRIGHT_MODULE:browser.playwright,PAGEPOSTER_CHROME:browser.chrome},stdio:['inherit','pipe','inherit']});
 let incomplete=false,pending='',allowedSkips=0,testCount=null,testCountLines=0;const summary={},summaryLines={};
 // This exact test uses skip:process.platform!=='win32' because DPAPI is a
 // Windows API. No other test name or explicit skip reason is exempted.
 const windowsKeyTest='Windows key is protected, stable across reads and not regenerated after corruption';
 function inspectLine(line){
  const count=/^# tests (\d+)\s*$/.exec(line);if(count){testCount=Number(count[1]);testCountLines++;}
  const counter=/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/.exec(line);if(counter){summary[counter[1]]=Number(counter[2]);summaryLines[counter[1]]=(summaryLines[counter[1]]||0)+1;}
  if(/^\s*(?:ok|not ok)\s+\d+.*# TODO\b/i.test(line))incomplete=true;
  if(/# SKIP\b/i.test(line)){
   const skipped=/^\s*ok \d+ - (.*?) # SKIP(?:\s+(.*))?\s*$/.exec(line);
   if(process.platform!=='win32'&&skipped?.[1]===windowsKeyTest&&!skipped[2]?.trim()&&allowedSkips===0)allowedSkips++;
   else incomplete=true;
  }
  const total=/^# skipped (\d+)\s*$/.exec(line);if(total&&Number(total[1])!==allowedSkips)incomplete=true;
 }
 child.stdout.on('data',data=>{process.stdout.write(data);pending+=data.toString();const lines=pending.split(/\r?\n/);pending=lines.pop();for(const line of lines)inspectLine(line);});
 await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{
  if(pending)inspectLine(pending);
  if(testCountLines!==1||!Number.isSafeInteger(testCount)||testCount<=0){incomplete=true;console.error('Full verification failed: a nonzero test count is required.');}
  if(['tests','pass','fail','cancelled','skipped','todo'].some(key=>summaryLines[key]!==1)||!summary.pass||summary.fail||summary.cancelled||summary.todo||summary.skipped!==allowedSkips||summary.tests!==summary.pass+summary.skipped){incomplete=true;console.error('Full verification failed: every test must execute and pass with a complete summary.');}
  if(incomplete)console.error('Full verification failed: tests are missing, empty, unfinished or unexpectedly skipped.');
  if(allowedSkips)console.log('Platform exclusion: the Windows DPAPI keyring test is unavailable on '+process.platform+'.');
  process.exitCode=code===0&&!incomplete?0:code||1;if(signal)console.error('Full verification was interrupted.');resolve();
 });});
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
