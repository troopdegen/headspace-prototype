import { json, isDeviceId } from '../lib/http.mjs';
import { appendCareAction, setCareFeedback } from '../lib/kv.mjs';
import Engine from '../lib/engine.mjs';

const { makeCareAction } = Engine;

// POST: log a new CareAction. Body: { deviceId, action: { activity, triggerContext } }
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  if (!isDeviceId(body.deviceId)) return json(400, { error: 'deviceId required' });
  let action;
  try {
    action = makeCareAction({ ...body.action, userId: body.deviceId, synthetic: false });
  } catch (e) {
    return json(400, { error: e.message });
  }
  await appendCareAction(body.deviceId, action);
  return json(201, { action });
}

// PATCH: set optional feedback on an existing action. Body: { deviceId, actionId, feedback }
export async function PATCH(request) {
  const body = await request.json().catch(() => ({}));
  if (!isDeviceId(body.deviceId) || !body.actionId) return json(400, { error: 'deviceId and actionId required' });
  const feedback = ['helped', 'not-helped', null].includes(body.feedback) ? body.feedback : null;
  const a = await setCareFeedback(body.deviceId, body.actionId, feedback);
  if (!a) return json(404, { error: 'not found' });
  return json(200, { action: a });
}
