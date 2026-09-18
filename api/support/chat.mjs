import { json, isDeviceId } from '../../lib/http.mjs';
import { runSupportChat, hasSupport } from '../../lib/agent.mjs';

// Nebius calls plus up to two Linkup search rounds can take a while; give this
// function room to stream past Vercel's default duration on Node functions.
export const config = { maxDuration: 60 };

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  if (!isDeviceId(body.deviceId)) return json(400, { error: 'deviceId required' });
  if (!hasSupport()) return json(503, { error: 'missing_key', message: 'NEBIUS_API_KEY is not set (add it in the Vercel project’s Environment Variables).' });

  const messages = Array.isArray(body.messages) ? body.messages.slice(-20) : [];
  const clean = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
  if (!clean.length || clean[clean.length - 1].role !== 'user') return json(400, { error: 'last message must be from the user' });

  const encoder = new TextEncoder();
  let controllerRef;
  const stream = new ReadableStream({
    start(controller) { controllerRef = controller; },
  });
  const emit = (obj) => controllerRef.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

  (async () => {
    try {
      await runSupportChat({ messages: clean, context: body.context }, emit);
    } catch (e) {
      console.error('support chat error', e.status || '', e.detail || e.message);
      emit({ error: e.status ? 'upstream' : 'stream_interrupted' });
    } finally {
      controllerRef.enqueue(encoder.encode('data: [DONE]\n\n'));
      controllerRef.close();
    }
  })();

  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' } });
}
