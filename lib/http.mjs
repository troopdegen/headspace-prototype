/* Tiny shared helpers for the Vercel functions under /api. Web-standard
   Request/Response only, no framework. */

export function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

export function isDeviceId(s) {
  return typeof s === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(s);
}
