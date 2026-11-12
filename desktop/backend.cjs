const fs = require('node:fs');
const path = require('node:path');
const {createLocalServer} = require('../server/local.cjs');
const {loadGoogleClient}=require('../server/lifecycle/google-client.cjs');
const {createSupportMetadata}=require('./support-metadata.cjs');

const failure = code => Object.assign(new Error(code === 'DESKTOP_TOKEN_INVALID' ? 'The private desktop session could not be initialized.' : 'The desktop backend configuration is invalid.'), {code});
function normalizeDesktopConfig(raw) {
  let value;
  try { value = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { throw failure('DESKTOP_CONFIG_INVALID'); }
  const allowed = ['appRoot', 'dataDir', 'keyDir', 'legacyEnvFile', 'port'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw failure('DESKTOP_CONFIG_INVALID');
  for (const name of ['appRoot', 'dataDir', 'keyDir']) if (typeof value[name] !== 'string' || !path.isAbsolute(value[name]) || value[name].includes('\0')) throw failure('DESKTOP_CONFIG_INVALID');
  if (value.legacyEnvFile != null && (typeof value.legacyEnvFile !== 'string' || !path.isAbsolute(value.legacyEnvFile) || value.legacyEnvFile.includes('\0'))) throw failure('DESKTOP_CONFIG_INVALID');
  if (value.port !== undefined && value.port !== 0) throw failure('DESKTOP_CONFIG_INVALID');
  return {appRoot:path.normalize(value.appRoot), dataDir:path.normalize(value.dataDir), keyDir:path.normalize(value.keyDir), legacyEnvFile:value.legacyEnvFile == null ? null : path.normalize(value.legacyEnvFile), port:0};
}

function createBackendOptions(raw, env = process.env) {
  const config = normalizeDesktopConfig(raw);
  if (typeof env.PAGEPOSTER_ACCESS_TOKEN !== 'string' || !/^[a-f0-9]{64}$/i.test(env.PAGEPOSTER_ACCESS_TOKEN)) throw failure('DESKTOP_TOKEN_INVALID');
  const runtimeEnv = {...env, PAGEPOSTER_DATA_DIR:config.dataDir, PAGEPOSTER_KEY_DIR:config.keyDir};
  delete runtimeEnv.PAGEPOSTER_PUBLIC_ORIGIN;
  delete runtimeEnv.PAGEPOSTER_DESKTOP_CONFIG;
  const googleClient=loadGoogleClient(path.join(config.appRoot,'desktop/google-client.json'));
  return {env:runtimeEnv, lifecycle:{dataDir:config.dataDir, keyDir:config.keyDir, desktop:true, visibleBrowserEnabled:true,...(googleClient?{googleClient}:{})}};
}

async function startDesktopBackend({config:raw = process.env.PAGEPOSTER_DESKTOP_CONFIG, env = process.env, createServer = createLocalServer, attachProcessHandlers = true} = {}) {
  const config = normalizeDesktopConfig(raw);
  // Capture the per-launch secret before the legacy file is loaded.
  const token = env.PAGEPOSTER_ACCESS_TOKEN;
  createBackendOptions(config, {...env, PAGEPOSTER_ACCESS_TOKEN:token});
  if (config.legacyEnvFile && fs.existsSync(config.legacyEnvFile)) process.loadEnvFile(config.legacyEnvFile);
  const options = createBackendOptions(config, {...env, PAGEPOSTER_ACCESS_TOKEN:token});
  const supportMetadata=createSupportMetadata({appRoot:config.appRoot});
  options.lifecycle.supportMetadata=()=>supportMetadata.get();
  let server = null, shuttingDown = false, shutdownPromise = null;
  // Chromium can preconnect without ever sending an HTTP byte. Node's HTTP
  // idle-connection cleanup does not drain these sockets during server.close.
  // Track only never-used sockets; any received data removes this capability.
  const preconnections = new Set();
  const trackPreconnection = socket => {preconnections.add(socket);const used=()=>{preconnections.delete(socket);};socket.once('data',used);socket.once('close',used);};
  const closeListener = () => new Promise((resolve,reject) => {server.close(error=>error?reject(error):resolve());for(const socket of preconnections)if(socket.bytesRead===0)socket.destroy();});
  const listeners = [];
  const removeHandlers = () => { for (const [event, handler] of listeners) process.off(event, handler); };
  const listen = (event, handler) => { process.on(event, handler); listeners.push([event, handler]); };
  let initializing;
  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    // quiesce sets the suspended flag synchronously, before waiting for active work.
    const paused = server?.lifecycle?.quiesce();
    const stopped = server?.listening ? closeListener() : null;
    shutdownPromise = (async () => {
      await initializing?.catch(() => {});
      await paused;
      await stopped;
      if (server?.listening) await closeListener();
      await server?.closeResources();
    })().finally(()=>{server?.off('connection',trackPreconnection);removeHandlers();});
    return shutdownPromise;
  }
  const stopFromProcess = () => { shutdown().then(() => { process.exitCode = 0; if (process.connected) process.disconnect(); }).catch(() => { process.exitCode = 1; if (process.connected) process.disconnect(); }); };
  if (attachProcessHandlers) {
    listen('message', message => {
      if (message && message.type === 'shutdown') stopFromProcess();
      // Child-process IPC is private to the trusted Electron main process. No HTTP/renderer path input.
      else if(message?.type==='support-metadata')supportMetadata.update(message.metadata);
    });
    listen('disconnect', stopFromProcess);
    listen('SIGINT', stopFromProcess);
    listen('SIGTERM', stopFromProcess);
  }
  initializing = (async () => {
    server = await createServer(options);
    server.on('connection',trackPreconnection);
    if (shuttingDown) return;
    await new Promise((resolve, reject) => {
      const failed = error => { server.off('listening', ready); reject(error); };
      const ready = () => { server.off('error', failed); resolve(); };
      server.once('error', failed);
      server.once('listening', ready);
      server.listen(0, '127.0.0.1');
    });
    server.on('error', stopFromProcess);
  })();
  try { await initializing; } catch (error) { await shutdown().catch(() => {}); throw error; }
  const port = server?.address()?.port || null;
  if (!shuttingDown && attachProcessHandlers && process.connected) process.send({type:'ready', port, pid:process.pid}, error => { if (error) stopFromProcess(); });
  return {server, port, shutdown};
}

function publicError(error) {
  const code = ['DESKTOP_CONFIG_INVALID', 'DESKTOP_TOKEN_INVALID', 'EADDRINUSE'].includes(error?.code) ? error.code : 'DESKTOP_START_FAILED';
  return {type:'error', code, message:code === 'DESKTOP_CONFIG_INVALID' ? 'The desktop backend configuration is invalid.' : code === 'DESKTOP_TOKEN_INVALID' ? 'The private desktop session could not be initialized.' : 'PagePoster could not start its desktop backend.'};
}

if (require.main === module) {
  startDesktopBackend().catch(error => {
    process.exitCode = 1;
    const message = publicError(error);
    if (process.connected) process.send(message, () => { if (process.connected) process.disconnect(); });
    else console.error(message.message);
  });
}

module.exports = {normalizeDesktopConfig, createBackendOptions, startDesktopBackend};
