import { json, isDeviceId } from '../lib/http.mjs';
import { setSignature } from '../lib/kv.mjs';
import Engine from '../lib/engine.mjs';

const { SYMPTOM_DEFS, CARE_ACTIVITIES } = Engine;

// PUT: upload the device's aggregate UserPatternSignature. Only the whitelisted
// aggregate fields are kept; anything else (dates, notes, raw values) is discarded.
export async function PUT(request) {
  const body = await request.json().catch(() => ({}));
  if (!isDeviceId(body.deviceId)) return json(400, { error: 'deviceId required' });
  const s = body.signature || {};
  const clean = {
    dominantSymptomCombination: Array.isArray(s.dominantSymptomCombination) ? s.dominantSymptomCombination.filter((t) => SYMPTOM_DEFS[t]).slice(0, 4) : [],
    secondaryCombinations: Array.isArray(s.secondaryCombinations) ? s.secondaryCombinations.slice(0, 3).map((c) => (Array.isArray(c) ? c.filter((t) => SYMPTOM_DEFS[t]).slice(0, 4) : [])) : [],
    cyclePhaseDistribution: Object.fromEntries(['menstrual', 'follicular', 'ovulation', 'luteal'].map((k) => [k, Math.max(0, Math.min(1, Number((s.cyclePhaseDistribution || {})[k]) || 0))])),
    topCareActionsUsed: Array.isArray(s.topCareActionsUsed) ? s.topCareActionsUsed.filter((a) => CARE_ACTIVITIES[a]).slice(0, 3) : [],
    topCareActionsHelped: Array.isArray(s.topCareActionsHelped) ? s.topCareActionsHelped.filter((a) => CARE_ACTIVITIES[a]).slice(0, 3) : [],
    patternCount: Number(s.patternCount) || 0,
  };
  await setSignature(body.deviceId, clean);
  return json(200, { ok: true });
}
