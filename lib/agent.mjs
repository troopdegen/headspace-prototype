/* =====================================================================================
   Emotional-support agent: Nebius Token Factory (OpenAI-compatible) + an optional
   Linkup web-search tool. Framework-free, callback-based (`emit`) so both a Vercel
   function (ReadableStream) and, if anyone runs this outside Vercel, a plain Node
   http response can drive it the same way.
===================================================================================== */
const NEBIUS_API_KEY = process.env.NEBIUS_API_KEY || '';
const NEBIUS_BASE_URL = (process.env.NEBIUS_BASE_URL || 'https://api.tokenfactory.nebius.com/v1').replace(/\/$/, '');
const NEBIUS_MODEL = process.env.NEBIUS_MODEL || 'Qwen/Qwen3-235B-A22B-Instruct-2507';

const LINKUP_API_KEY = process.env.LINKUP_API_KEY || '';
const LINKUP_BASE_URL = (process.env.LINKUP_BASE_URL || 'https://api.linkup.so/v1').replace(/\/$/, '');
const LINKUP_DEPTH = process.env.LINKUP_DEPTH || 'fast';

export const hasSupport = () => !!NEBIUS_API_KEY;
export const hasSearch = () => !!LINKUP_API_KEY;
export const modelName = () => NEBIUS_MODEL;

const SUPPORT_SYSTEM_PROMPT = `You are the warm presence inside "shape", a companion for people tracking how their body and mind feel across their menstrual cycle. Right now you are in emotional-support mode: the person wants to share what they feel and find a little relief or understanding.

How you are:
- Warm, unhurried, present. You listen first. Reflect back what you heard and validate the feeling before anything else.
- Plain, human language. Short replies: two to five sentences. No lists unless the person explicitly asks for options, and then at most three.
- Plain text only: no markdown, no asterisks, no headings, no bullet symbols.
- At most one gentle, open question per reply. Never interrogate. Silence and "that sounds heavy" are fine answers.
- No toxic positivity, no minimizing, no "at least", no emojis, no therapy jargon.
- Mirror the person's language (Spanish or English) and their register. If they write in Spanish, answer in natural Mexican Spanish.

Boundaries:
- You never diagnose, never name a condition, never claim one thing causes another, never give medical or medication advice. If asked something medical, say gently that a healthcare professional is the right person for that, then stay with the feeling.
- You may offer simple, low-risk ways to settle when it fits or when asked: slow breathing, warmth on the body, rest, writing it out, gentle movement, reaching out to someone they trust. Offer, never prescribe.
- You are not a substitute for a therapist or crisis service, and you say so if the person seems to need more than a conversation.

If the person mentions wanting to hurt themselves, not wanting to be here, or being in danger: take it seriously and stay warm. Say you are glad they told you, encourage them to reach a person right now, and share these: in Mexico, Línea de la Vida 800 911 2000 (free, 24/7); in the US, call or text 988; elsewhere, local emergency services or a local crisis line. Keep talking with them; do not end the conversation.

Everything you know about the person comes from their own self-reports in this app (in this prototype the history is synthetic demo data). Treat it as their words, not facts about their health.`;

const SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'search_web',
    description: 'Look up general, reputable information on the web when the person asks a practical question or for resources: what a self-care practice involves, how to prepare for a doctor visit, how to find a therapist or support line, what a term means in general. Never use it to diagnose, to interpret their symptoms, or when they only need to be heard. Ask in the language the person is using.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: "A focused search query in the person's language" } }, required: ['query'] },
  },
};
const SEARCH_GUIDANCE = `

You can look things up with the search_web tool. Use it only for practical questions and resources (self-care practices, how to talk to a doctor, where to find support, what a term means in general), never to diagnose or to interpret what their symptoms mean. When you share what you found, keep it short, say it is general information, keep your warmth, and mention that the sources are shown under your reply. Only give specific facts such as phone numbers, addresses, names of services or dosages if they appear in the search results; if the search did not return them, say you could not confirm them rather than guessing.`;

function supportContextBlock(ctx = {}) {
  const lines = [];
  if (ctx.symptomType) lines.push(`They opened this conversation after reporting: ${String(ctx.symptomType).slice(0, 60)}.`);
  if (ctx.patternText) lines.push(`A pattern the app has observed in their own reports: ${String(ctx.patternText).slice(0, 300)}`);
  if (ctx.careText) lines.push(`Something they have said helped before: ${String(ctx.careText).slice(0, 200)}`);
  if (ctx.phase) lines.push(`Their current self-reported cycle phase: ${String(ctx.phase).slice(0, 20)}.`);
  return lines.length ? `\n\nContext about this person (self-reported):\n- ${lines.join('\n- ')}` : '';
}

async function linkupSearch(query) {
  if (!LINKUP_API_KEY) return { ok: false, text: 'Search is not available right now (no LINKUP_API_KEY configured).', sources: [] };
  try {
    const r = await fetch(`${LINKUP_BASE_URL}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINKUP_API_KEY}` },
      body: JSON.stringify({ q: String(query).slice(0, 300), depth: LINKUP_DEPTH, outputType: 'sourcedAnswer', maxResults: 5 }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) { console.error('linkup error', r.status, (await r.text().catch(() => '')).slice(0, 200)); return { ok: false, text: `Search failed (status ${r.status}).`, sources: [] }; }
    const data = await r.json();
    const sources = (data.sources || []).slice(0, 5).map((x) => ({ name: x.name, url: x.url, snippet: (x.snippet || '').slice(0, 200) }));
    return { ok: true, text: String(data.answer || '').slice(0, 2500), sources };
  } catch (e) {
    console.error('linkup error', e.message);
    return { ok: false, text: 'Search timed out or failed.', sources: [] };
  }
}

// One streaming round-trip to Nebius. Calls emit({delta}) as content arrives and
// returns any tool calls the model made (accumulated across the delta chunks).
async function streamModel(messages, emit, { tools } = {}) {
  const body = { model: NEBIUS_MODEL, stream: true, temperature: 0.7, max_tokens: 500, messages };
  if (tools) body.tools = tools;
  let upstream = await fetch(`${NEBIUS_BASE_URL}/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${NEBIUS_API_KEY}` }, body: JSON.stringify(body),
  });
  if (!upstream.ok && tools) {
    console.error('nebius rejected tools', upstream.status, (await upstream.text().catch(() => '')).slice(0, 200));
    delete body.tools;
    upstream = await fetch(`${NEBIUS_BASE_URL}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${NEBIUS_API_KEY}` }, body: JSON.stringify(body) });
  }
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    const err = new Error('upstream'); err.status = upstream.status; err.detail = text.slice(0, 300);
    throw err;
  }
  const decoder = new TextDecoder();
  const toolCalls = [];
  let buf = '', content = '';
  for await (const chunk of upstream.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let delta; try { delta = JSON.parse(payload).choices?.[0]?.delta; } catch { continue; }
      if (!delta) continue;
      if (delta.content) { content += delta.content; emit({ delta: delta.content }); }
      (delta.tool_calls || []).forEach((tc) => {
        const i = tc.index ?? 0;
        toolCalls[i] = toolCalls[i] || { id: tc.id || 'call_' + i, name: '', arguments: '' };
        if (tc.id) toolCalls[i].id = tc.id;
        if (tc.function?.name) toolCalls[i].name += tc.function.name;
        if (tc.function?.arguments) toolCalls[i].arguments += tc.function.arguments;
      });
    }
  }
  return { content, toolCalls: toolCalls.filter(Boolean) };
}

// The full turn: system prompt + up to two search rounds, forced answer on the third.
// `emit` receives { delta } | { status: 'searching', query } | { sources } | { error }.
export async function runSupportChat({ messages, context }, emit) {
  const system = SUPPORT_SYSTEM_PROMPT + (hasSearch() ? SEARCH_GUIDANCE : '') + supportContextBlock(context);
  let history = [{ role: 'system', content: system }, ...messages];
  let lastFound = null, result = null;
  for (let round = 0; round < 3; round++) {
    const tools = hasSearch() && round < 2 ? [SEARCH_TOOL] : undefined;
    result = await streamModel(history, emit, { tools });
    const call = result.toolCalls.find((t) => t.name === 'search_web');
    if (!call || result.content) break;
    let query = ''; try { query = JSON.parse(call.arguments || '{}').query || ''; } catch { query = call.arguments; }
    emit({ status: 'searching', query });
    lastFound = await linkupSearch(query);
    if (lastFound.sources.length) emit({ sources: lastFound.sources });
    history = [
      ...history,
      { role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function', function: { name: 'search_web', arguments: JSON.stringify({ query }) } }] },
      { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: lastFound.ok, answer: lastFound.text, sources: lastFound.sources.map((x) => ({ name: x.name, url: x.url })) }) },
    ];
  }
  if (result && !result.content && lastFound) {
    const fallback = lastFound.ok && lastFound.text
      ? `Esto es lo que encontré, como información general: ${lastFound.text}`
      : 'No pude encontrar información confiable sobre eso ahora mismo, pero sigo aquí contigo.';
    emit({ delta: fallback });
  }
}
