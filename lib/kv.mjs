/* =====================================================================================
   Zero-dependency Upstash Redis REST client + the device store built on it.
   This is the persistence layer for Vercel: no local disk, works from any
   serverless invocation. Same shape as the old JSON file store it replaces:
   devices[deviceId] = { careActions: CareAction[], signature: UserPatternSignature|null, updatedAt }

   Env vars (either naming works):
     KV_REST_API_URL / KV_REST_API_TOKEN: injected by Vercel's Upstash integration
     UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN: if you point at Upstash directly
===================================================================================== */
import { createHash } from 'node:crypto';

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

export const kvConfigured = () => !!(KV_URL && KV_TOKEN);

async function kv(...command) {
  if (!kvConfigured()) throw Object.assign(new Error('KV is not configured (no KV_REST_API_URL/TOKEN).'), { code: 'kv_not_configured' });
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const data = await r.json();
  if (data.error) throw Object.assign(new Error(data.error), { code: 'kv_error' });
  return data.result;
}

const deviceKey = (id) => `shape:device:${id}`;
const REGISTRY_KEY = 'shape:devices'; // set of deviceIds that have ever uploaded a signature
const SALT_KEY = 'shape:salt';

const emptyDevice = () => ({ careActions: [], signature: null, updatedAt: 0 });

export async function getDevice(deviceId) {
  const raw = await kv('GET', deviceKey(deviceId));
  if (!raw) return emptyDevice();
  try { return JSON.parse(raw); } catch { return emptyDevice(); }
}

async function putDevice(deviceId, device) {
  await kv('SET', deviceKey(deviceId), JSON.stringify(device));
}

export async function appendCareAction(deviceId, action) {
  const d = await getDevice(deviceId);
  d.careActions.push(action);
  d.updatedAt = Date.now();
  await putDevice(deviceId, d);
  return d;
}

export async function setCareFeedback(deviceId, actionId, feedback) {
  const d = await getDevice(deviceId);
  const a = d.careActions.find((x) => x.id === actionId);
  if (!a) return null;
  a.feedback = feedback;
  d.updatedAt = Date.now();
  await putDevice(deviceId, d);
  return a;
}

export async function setSignature(deviceId, signature) {
  const d = await getDevice(deviceId);
  d.signature = signature;
  d.updatedAt = Date.now();
  await putDevice(deviceId, d);
  await kv('SADD', REGISTRY_KEY, deviceId);
}

// [{ id: deviceId, signature }] for every device that has ever uploaded one.
export async function listSignatures() {
  const ids = (await kv('SMEMBERS', REGISTRY_KEY)) || [];
  if (!ids.length) return [];
  const raws = await kv('MGET', ...ids.map(deviceKey));
  const out = [];
  ids.forEach((id, i) => {
    if (!raws[i]) return;
    try {
      const d = JSON.parse(raws[i]);
      if (d.signature) out.push({ id, signature: d.signature });
    } catch { /* skip a corrupt record rather than fail the whole read */ }
  });
  return out;
}

export async function deviceCount() {
  return (await kv('SCARD', REGISTRY_KEY)) || 0;
}

// Lazily created, persisted once. SET ... NX so two cold starts racing to
// create it can't clobber each other; both re-read afterward to converge.
let saltCache = null;
export async function getSalt() {
  if (saltCache) return saltCache;
  let salt = await kv('GET', SALT_KEY);
  if (!salt) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const candidate = Buffer.from(bytes).toString('hex');
    await kv('SET', SALT_KEY, candidate, 'NX');
    salt = await kv('GET', SALT_KEY);
  }
  saltCache = salt;
  return salt;
}

export async function anonymize(deviceId) {
  const salt = await getSalt();
  return 'dev-' + createHash('sha256').update(salt + deviceId).digest('hex').slice(0, 16);
}
