const fs = require('node:fs');
const path = require('node:path');
const {parseEnv} = require('node:util');

function absolute(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new TypeError('Invalid desktop '+name);
  return path.normalize(value);
}

function legacyPaths(filename, readFileSync) {
  if (!filename) return {};
  try {
    const parsed = parseEnv(readFileSync(filename, 'utf8'));
    return {PAGEPOSTER_DATA_DIR:parsed.PAGEPOSTER_DATA_DIR, PAGEPOSTER_KEY_DIR:parsed.PAGEPOSTER_KEY_DIR};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw Object.assign(new Error('Could not read desktop workspace path configuration.'), {code:'DESKTOP_PATH_CONFIG_INVALID'});
  }
}

// Resolves locations only. Existing workspace databases and DPAPI keys stay in place.
function resolveDesktopPaths({appRoot, resourcesPath, userDataPath, isPackaged = false, bootstrap = null, env = process.env, existsSync = fs.existsSync, readFileSync = fs.readFileSync} = {}) {
  appRoot = absolute(appRoot, 'app root');
  const workspaceRoot = bootstrap?.workspaceRoot ? absolute(bootstrap.workspaceRoot, 'workspace root') : null;
  const legacyRoot = isPackaged ? workspaceRoot : appRoot;
  const legacyEnvFile = legacyRoot ? path.join(legacyRoot, '.env') : null;
  const filePaths = legacyPaths(legacyEnvFile, readFileSync);
  const configuredPath = name => {
    // Existing environment values, including empty strings, win just as with loadEnvFile.
    const value = env[name] === undefined ? filePaths[name] : env[name];
    if (value === undefined || value === '') return null;
    if (typeof value !== 'string' || value.includes('\0')) throw new TypeError('Invalid desktop workspace path');
    return path.resolve(legacyRoot || appRoot, value);
  };
  const configuredDataDir = configuredPath('PAGEPOSTER_DATA_DIR');
  const configuredKeyDir = configuredPath('PAGEPOSTER_KEY_DIR');
  if (!isPackaged) {
    const userRoot = env.USERPROFILE || env.HOME;
    const nodePath = env.PAGEPOSTER_NODE_PATH || (userRoot && path.join(userRoot, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'));
    const dataDir = configuredDataDir || path.join(appRoot, '.pageposter', 'data');
    return {nodePath:absolute(nodePath, 'Node runtime'), dataDir, keyDir:configuredKeyDir || path.resolve(dataDir, '..', 'keys'), legacyEnvFile};
  }
  resourcesPath = absolute(resourcesPath, 'resources path');
  userDataPath = absolute(userDataPath, 'user data path');
  const existing = workspaceRoot && existsSync(path.join(workspaceRoot, '.pageposter'));
  const stateRoot = existing ? path.join(workspaceRoot, '.pageposter') : path.join(userDataPath, 'workspace');
  const dataDir = configuredDataDir || path.join(stateRoot, 'data');
  return {nodePath:path.join(resourcesPath, 'node', 'node.exe'), dataDir, keyDir:configuredKeyDir || path.resolve(dataDir, '..', 'keys'), legacyEnvFile};
}

module.exports = {resolveDesktopPaths};
