import { json, isDeviceId } from '../lib/http.mjs';
import { getDevice } from '../lib/kv.mjs';

export async function GET(request) {
  const url = new URL(request.url);
  const deviceId = url.searchParams.get('deviceId');
  if (!isDeviceId(deviceId)) return json(400, { error: 'deviceId required' });
  const d = await getDevice(deviceId);
  return json(200, { careActions: d.careActions, hasSignature: !!d.signature });
}
