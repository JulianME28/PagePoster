const fs = require('node:fs');
const path = require('node:path');
const envPath=path.join(__dirname,'.env');
if(fs.existsSync(envPath))process.loadEnvFile(envPath);
const bind=process.env.PAGEPOSTER_BIND_ADDRESS||'127.0.0.1';
if(!['127.0.0.1','0.0.0.0'].includes(bind)||(bind==='0.0.0.0'&&!(process.env.PAGEPOSTER_ACCESS_TOKEN?.length>=32)))throw Error('Remote binding requires a private access token.');
require('./server/local.cjs').createLocalServer({lifecycle:{dataDir:process.env.PAGEPOSTER_DATA_DIR||path.join(__dirname,'.pageposter','data'),visibleBrowserEnabled:bind==='127.0.0.1'&&process.platform==='win32'}}).then(server=>{
  server.on('error',error=>{console.error(error.code==='EADDRINUSE'?'PagePoster already runs on http://127.0.0.1:4317':'PagePoster could not start.');process.exitCode=1;});
  const shutdown=()=>server.close(()=>{server.closeResources().then(()=>process.exit(0)).catch(()=>process.exit(1));});
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
  server.listen(4317,bind,()=>console.log('PagePoster: http://127.0.0.1:4317'));
}).catch(()=>{console.error('PagePoster could not start. Use Node.js 24 or newer.');process.exitCode=1;});
