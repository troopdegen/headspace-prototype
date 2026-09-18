import { json, isDeviceId } from '../lib/http.mjs';
import { getDevice, listSignatures, anonymize } from '../lib/kv.mjs';
import Engine from '../lib/engine.mjs';

const { generatePopulation, buildSignature, clusterSignatures, rankClustersFor } = Engine;
const K_FLOOR = Number(process.env.K_FLOOR || 5);

// Regenerated once per lambda instance per day (deterministic, cheap: 60 personas).
let cachedPopulation = null, cachedDay = null;
function getPopulationSignatures() {
  const dayKey = new Date().toDateString();
  if (!cachedPopulation || cachedDay !== dayKey) {
    cachedPopulation = generatePopulation({}).map((p) => buildSignature({ anonymizedId: p.anonymizedId, history: p.persona.history, careActions: p.persona.careActions }));
    cachedDay = dayKey;
  }
  return cachedPopulation;
}

export async function GET(request) {
  const url = new URL(request.url);
  const deviceId = url.searchParams.get('deviceId');

  const real = await listSignatures(); // [{ id: deviceId, signature }]
  const realSigs = await Promise.all(real.map(async (r) => ({ ...r.signature, anonymizedId: await anonymize(r.id) })));
  const pool = [...getPopulationSignatures(), ...realSigs];
  const { clusters, membership, k, dropped } = clusterSignatures(pool, { k: K_FLOOR });

  let mine = null, ranked = clusters;
  if (isDeviceId(deviceId)) {
    const d = await getDevice(deviceId);
    if (d.signature) {
      mine = membership[await anonymize(deviceId)] || null;
      ranked = rankClustersFor(d.signature, clusters);
    }
  }

  return json(200, {
    clusters: ranked, myClusterId: mine, k, droppedBelowFloor: dropped, poolSize: pool.length, realCount: real.length,
    privacy: { kFloor: k, note: 'Similarity is based on self-reported patterns, not clinical information. Groups under the floor are merged or hidden. Only group aggregates are ever returned.' },
  });
}
