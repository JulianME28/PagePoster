import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function error(code, message) {
  return Object.assign(new Error(message), { code });
}
function base64(value, size) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid encoding');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (size !== undefined && bytes.length !== size)) throw new Error('Invalid length');
  return bytes;
}
function siteIdentity(siteId) {
  if (typeof siteId !== 'string' || !siteId.length || siteId.length > 200) throw error('VALIDATION', 'A site identity is required.');
  return Buffer.from(siteId, 'utf8');
}
const passwordLimit=id=>id==='pageposter:proxies:v1'?131072:['pageposter:source:v1','pageposter:google-oauth:v1'].includes(id)?32768:4096;
function credentials(value, maxPasswordLength = 4096) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['username', 'applicationPassword'].includes(key)) ||
      typeof value.username !== 'string' || !value.username || value.username.length > 1000 ||
      typeof value.applicationPassword !== 'string' || !value.applicationPassword || value.applicationPassword.length > maxPasswordLength) {
    throw error('VALIDATION', 'Both WordPress credential fields are required.');
  }
  return { username: value.username, applicationPassword: value.applicationPassword };
}

/** The caller supplies the key from server configuration; it is never stored beside the database. */
export function createSecretBox(masterKey) {
  let key;
  try { key = base64(masterKey, 32); } catch { throw error('VALIDATION', 'A canonical base64 32-byte master key is required.'); }
  return Object.freeze({
    encrypt(siteId, value) {
      const aad = siteIdentity(siteId), plain = credentials(value,passwordLimit(siteId)), iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
      return { version: 1, algorithm: 'aes-256-gcm', iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
    },
    decrypt(siteId, envelope) {
      try {
        const aad = siteIdentity(siteId);
        if (!envelope || envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm' ||
            Object.keys(envelope).some(key => !['version', 'algorithm', 'iv', 'ciphertext', 'tag'].includes(key))) throw new Error('Invalid envelope');
        const cipher = createDecipheriv('aes-256-gcm', key, base64(envelope.iv, 12));
        cipher.setAAD(aad);
        cipher.setAuthTag(base64(envelope.tag, 16));
        const plaintext = Buffer.concat([cipher.update(base64(envelope.ciphertext)), cipher.final()]);
        return credentials(JSON.parse(plaintext.toString('utf8')),passwordLimit(siteId));
      } catch { throw error('SECRET_DECRYPT_FAILED', 'Stored credentials could not be authenticated.'); }
    }
  });
}

