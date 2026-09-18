import { json } from '../lib/http.mjs';
import { kvConfigured, deviceCount } from '../lib/kv.mjs';
import { hasSupport, hasSearch, modelName } from '../lib/agent.mjs';

export async function GET() {
  const configured = kvConfigured();
  const devices = configured ? await deviceCount().catch(() => 0) : 0;
  return json(200, {
    ok: true,
    storage: configured ? 'kv' : 'none',
    devices,
    support: hasSupport(),
    model: hasSupport() ? modelName() : null,
    search: hasSearch(),
  });
}
