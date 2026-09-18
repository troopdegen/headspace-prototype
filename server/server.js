/* =====================================================================================
   SHAPE SERVER: persistence for the care layer + k-anonymous community clustering.
   Zero dependencies (node:http, node:fs, node:crypto). Node 18+.

   Storage model (server/data/store.json):
     devices[deviceId] = { careActions: CareAction[], signature: UserPatternSignature|null, updatedAt }

   Privacy model:
     - Raw observations never reach the server. Devices upload only their
       UserPatternSignature (aggregates) plus their own CareActions.
     - deviceId is a random UUID minted on the device. Server derives anonymizedId =
       sha256(salt + deviceId) for anything that enters the clustering pool.
     - Clusters are computed over synthetic population + real devices and returned
       ONLY as aggregates. Any cluster under k (default 5) is merged or dropped.
     - The only per-person fact ever returned is the caller's own clusterId.
===================================================================================== */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const E = require('../engine.js');

const PORT = Number(process.env.PORT || 4177);
const K_FLOOR = Number(process.env.K_FLOOR || 5);
// Emotional-support model (Nebius Token Factory, OpenAI-compatible). Key lives in server/.env, never in code.
const NEBIUS_API_KEY = process.env.NEBIUS_API_KEY || '';
const NEBIUS_BASE_URL = (process.env.NEBIUS_BASE_URL || 'https://api.tokenfactory.nebius.com/v1').replace(/\/$/, '');
const NEBIUS_MODEL = process.env.NEBIUS_MODEL || 'Qwen/Qwen3-235B-A22B-Instruct-2507';
// Web search for the support agent (Linkup). Optional: without a key the agent simply can't look things up.
const LINKUP_API_KEY = process.env.LINKUP_API_KEY || '';
const LINKUP_BASE_URL = (process.env.LINKUP_BASE_URL || 'https://api.linkup.so/v1').replace(/\/$/, '');
const LINKUP_DEPTH = process.env.LINKUP_DEPTH || 'fast';
const ROOT = path.resolve(__dirname, '..');            // prototype/ (static files)
const DATA_DIR = path.join(__dirname, 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');
const SALT_PATH = path.join(DATA_DIR, 'salt');

/* ---------- store ---------- */
function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')); } catch { return { devices: {} }; }
}
let store = loadStore();
let saveTimer = null;
function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
  }, 50);
}
function getSalt() {
  try { return fs.readFileSync(SALT_PATH, 'utf8').trim(); } catch {
    const s = crypto.randomBytes(16).toString('hex');
    fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(SALT_PATH, s); return s;
  }
}
const SALT = getSalt();
const anonymize = (deviceId) => 'dev-' + crypto.createHash('sha256').update(SALT + deviceId).digest('hex').slice(0, 16);
const isDeviceId = (s) => typeof s === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(s);
function device(deviceId) {
  if (!store.devices[deviceId]) store.devices[deviceId] = { careActions: [], signature: null, updatedAt: Date.now() };
  return store.devices[deviceId];
}

/* ---------- synthetic population (regenerated daily so dates stay relative to "today") ---------- */
let population = null, populationDay = null;
function getPopulationSignatures() {
  const dayKey = new Date().toDateString();
  if (!population || populationDay !== dayKey) {
    population = E.generatePopulation({}).map(p => E.buildSignature({ anonymizedId: p.anonymizedId, history: p.persona.history, careActions: p.persona.careActions }));
    populationDay = dayKey;
  }
  return population;
}

/* ---------- clustering (the "process" from the spec) ---------- */
function computeClusters() {
  const real = Object.entries(store.devices)
    .filter(([, d]) => d.signature)
    .map(([id, d]) => ({ ...d.signature, anonymizedId: anonymize(id) }));
  const pool = [...getPopulationSignatures(), ...real];
  const result = E.clusterSignatures(pool, { k: K_FLOOR });
  return { ...result, poolSize: pool.length, realCount: real.length };
}

/* ---------- http helpers ---------- */
function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,OPTIONS' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 200000) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT) || file.startsWith(path.join(ROOT, 'server', 'data'))) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

/* ---------- emotional support agent ----------
   A presence to share feelings with and seek relief or understanding. Not therapy,
   not medical advice, never a diagnosis. Transcripts are relayed to the model and
   never written to the store. */
const SUPPORT_SYSTEM_PROMPT = `You are the warm presence inside "shape", a companion for people tracking how their body and mind feel across their menstrual cycle. Right now you are in emotional-support mode: the person wants to share what they feel and find a little relief or understanding.

How you are:
- Warm, unhurried, present. You listen first. Reflect back what you heard and validate the feeling before anything else.
- Plain, human language. Short replies: two to five sentences. No lists unless the person explicitly asks for options, and then at most three.
- At most one gentle, open question per reply. Never interrogate. Silence and "that sounds heavy" are fine answers.
- No toxic positivity, no minimizing, no "at least", no emojis, no therapy jargon.
- Plain text only: no markdown, no asterisks, no headings, no bullet symbols.
- Mirror the person's language (Spanish or English) and their register. If they write in Spanish, answer in natural Mexican Spanish.

Boundaries:
- You never diagnose, never name a condition, never claim one thing causes another, never give medical or medication advice. If asked something medical, say gently that a healthcare professional is the right person for that, then stay with the feeling.
- You may offer simple, low-risk ways to settle when it fits or when asked: slow breathing, warmth on the body, rest, writing it out, gentle movement, reaching out to someone they trust. Offer, never prescribe.
- You are not a substitute for a therapist or crisis service, and you say so if the person seems to need more than a conversation.

If the person mentions wanting to hurt themselves, not wanting to be here, or being in danger: take it seriously and stay warm. Say you are glad they told you, encourage them to reach a person right now, and share these: in Mexico, Línea de la Vida 800 911 2000 (free, 24/7); in the US, call or text 988; elsewhere, local emergency services or a local crisis line. Keep talking with them; do not end the conversation.

Everything you know about the person comes from their own self-reports in this app (in this prototype the history is synthetic demo data). Treat it as their words, not facts about their health.`;

function supportContextBlock(ctx = {}) {
  const lines = [];
  if (ctx.symptomType) lines.push(`They opened this conversation after reporting: ${String(ctx.symptomType).slice(0, 60)}.`);
  if (ctx.patternText) lines.push(`A pattern the app has observed in their own reports: ${String(ctx.patternText).slice(0, 300)}`);
  if (ctx.careText) lines.push(`Something they have said helped before: ${String(ctx.careText).slice(0, 200)}`);
  if (ctx.phase) lines.push(`Their current self-reported cycle phase: ${String(ctx.phase).slice(0, 20)}.`);
  return lines.length ? `\n\nContext about this person (self-reported):\n- ${lines.join('\n- ')}` : '';
}

const SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'search_web',
    description: 'Look up general, reputable information on the web when the person asks a practical question or for resources: what a self-care practice involves, how to prepare for a doctor visit, how to find a therapist or support line, what a term means in general. Never use it to diagnose, to interpret their symptoms, or when they only need to be heard. Ask in the language the person is using.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'A focused search query in the person\'s language' } }, required: ['query'] },
  },
};
const SEARCH_GUIDANCE = `

You can look things up with the search_web tool. Use it only for practical questions and resources (self-care practices, how to talk to a doctor, where to find support, what a term means in general), never to diagnose or to interpret what their symptoms mean. When you share what you found, keep it short, say it is general information, keep your warmth, and mention that the sources are shown under your reply. Only give specific facts such as phone numbers, addresses, names of services or dosages if they appear in the search results; if the search did not return them, say you could not confirm them rather than guessing.`;

async function linkupSearch(query) {
  if (!LINKUP_API_KEY) return { ok: false, text: 'Search is not available right now (no LINKUP_API_KEY on the server).', sources: [] };
  try {
    const r = await fetch(`${LINKUP_BASE_URL}/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINKUP_API_KEY}` },
      body: JSON.stringify({ q: String(query).slice(0, 300), depth: LINKUP_DEPTH, outputType: 'sourcedAnswer', maxResults: 5 }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) { console.error('linkup error', r.status, (await r.text().catch(() => '')).slice(0, 200)); return { ok: false, text: `Search failed (status ${r.status}).`, sources: [] }; }
    const data = await r.json();
    const sources = (data.sources || []).slice(0, 5).map(x => ({ name: x.name, url: x.url, snippet: (x.snippet || '').slice(0, 200) }));
    return { ok: true, text: String(data.answer || '').slice(0, 2500), sources };
  } catch (e) {
    console.error('linkup error', e.message);
    return { ok: false, text: 'Search timed out or failed.', sources: [] };
  }
}

// One streaming round-trip to the model. Relays content deltas to `res` as SSE and
// returns any tool calls the model made (accumulated from the deltas).
async function streamModel(messages, res, { tools } = {}) {
  const body = { model: NEBIUS_MODEL, stream: true, temperature: 0.7, max_tokens: 500, messages };
  if (tools) body.tools = tools;
  let upstream = await fetch(`${NEBIUS_BASE_URL}/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${NEBIUS_API_KEY}` }, body: JSON.stringify(body),
  });
  if (!upstream.ok && tools) {
    // Model or provider without tool support: retry without tools rather than failing the conversation.
    console.error('nebius rejected tools', upstream.status, (await upstream.text().catch(() => '')).slice(0, 200));
    delete body.tools;
    upstream = await fetch(`${NEBIUS_BASE_URL}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${NEBIUS_API_KEY}` }, body: JSON.stringify(body) });
  }
  if (!upstream.ok) { const text = await upstream.text().catch(() => ''); const err = new Error('upstream'); err.status = upstream.status; err.detail = text.slice(0, 300); throw err; }
  const decoder = new TextDecoder();
  const toolCalls = []; // index → { id, name, arguments }
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
      if (delta.content) { content += delta.content; res.write(`data: ${JSON.stringify({ delta: delta.content })}\n\n`); }
      (delta.tool_calls || []).forEach(tc => {
        const i = tc.index ?? 0;
        toolCalls[i] = toolCalls[i] || { id: tc.id || ('call_' + i), name: '', arguments: '' };
        if (tc.id) toolCalls[i].id = tc.id;
        if (tc.function?.name) toolCalls[i].name += tc.function.name;
        if (tc.function?.arguments) toolCalls[i].arguments += tc.function.arguments;
      });
    }
  }
  return { content, toolCalls: toolCalls.filter(Boolean) };
}

async function handleSupportChat(req, res) {
  const body = await readBody(req);
  if (!isDeviceId(body.deviceId)) return json(res, 400, { error: 'deviceId required' });
  if (!NEBIUS_API_KEY) return json(res, 503, { error: 'missing_key', message: 'NEBIUS_API_KEY is not set on the server (put it in server/.env).' });
  const messages = Array.isArray(body.messages) ? body.messages.slice(-20) : [];
  const clean = messages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
  if (!clean.length || clean[clean.length - 1].role !== 'user') return json(res, 400, { error: 'last message must be from the user' });

  const system = SUPPORT_SYSTEM_PROMPT + (LINKUP_API_KEY ? SEARCH_GUIDANCE : '') + supportContextBlock(body.context);
  const convo = [{ role: 'system', content: system }, ...clean];

  // Our SSE to the client: data: {"delta"} | {"status":"searching","query"} | {"sources":[...]} | [DONE]
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
  try {
    // Up to two search rounds per turn; the last pass runs without tools so it must answer.
    let history = convo, lastFound = null, result = null;
    for (let round = 0; round < 3; round++) {
      const tools = LINKUP_API_KEY && round < 2 ? [SEARCH_TOOL] : undefined;
      result = await streamModel(history, res, { tools });
      const call = result.toolCalls.find(t => t.name === 'search_web');
      if (!call || result.content) break;
      let query = ''; try { query = JSON.parse(call.arguments || '{}').query || ''; } catch { query = call.arguments; }
      res.write(`data: ${JSON.stringify({ status: 'searching', query })}\n\n`);
      lastFound = await linkupSearch(query);
      if (lastFound.sources.length) res.write(`data: ${JSON.stringify({ sources: lastFound.sources })}\n\n`);
      history = [
        ...history,
        { role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function', function: { name: 'search_web', arguments: JSON.stringify({ query }) } }] },
        { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: lastFound.ok, answer: lastFound.text, sources: lastFound.sources.map(x => ({ name: x.name, url: x.url })) }) },
      ];
    }
    if (result && !result.content && lastFound) {
      // The model went quiet after searching: hand over what was found rather than nothing.
      const fallback = lastFound.ok && lastFound.text ? `Esto es lo que encontré, como información general: ${lastFound.text}` : 'No pude encontrar información confiable sobre eso ahora mismo, pero sigo aquí contigo.';
      res.write(`data: ${JSON.stringify({ delta: fallback })}\n\n`);
    }
  } catch (e) {
    console.error('support chat error', e.status || '', e.detail || e.message);
    res.write(`data: ${JSON.stringify({ error: e.status ? 'upstream' : 'stream_interrupted' })}\n\n`);
  }
  res.write('data: [DONE]\n\n'); res.end();
}

/* ---------- routes ---------- */
async function handleApi(req, res, url) {
  const p = url.pathname;
  const deviceId = url.searchParams.get('deviceId');

  if (req.method === 'GET' && p === '/api/health') return json(res, 200, { ok: true, k: K_FLOOR, devices: Object.keys(store.devices).length, support: !!NEBIUS_API_KEY, model: NEBIUS_API_KEY ? NEBIUS_MODEL : null, search: !!LINKUP_API_KEY });

  if (req.method === 'POST' && p === '/api/support/chat') return handleSupportChat(req, res);

  if (req.method === 'GET' && p === '/api/me') {
    if (!isDeviceId(deviceId)) return json(res, 400, { error: 'deviceId required' });
    const d = device(deviceId);
    return json(res, 200, { careActions: d.careActions, hasSignature: !!d.signature });
  }

  if (req.method === 'POST' && p === '/api/care') {
    const body = await readBody(req);
    if (!isDeviceId(body.deviceId)) return json(res, 400, { error: 'deviceId required' });
    let action;
    try { action = E.makeCareAction({ ...body.action, userId: body.deviceId, synthetic: false }); }
    catch (e) { return json(res, 400, { error: e.message }); }
    const d = device(body.deviceId);
    d.careActions.push(action); d.updatedAt = Date.now(); saveStore();
    return json(res, 201, { action });
  }

  if (req.method === 'PATCH' && p.startsWith('/api/care/')) {
    const id = decodeURIComponent(p.slice('/api/care/'.length));
    const body = await readBody(req);
    if (!isDeviceId(body.deviceId)) return json(res, 400, { error: 'deviceId required' });
    const d = device(body.deviceId);
    const a = d.careActions.find(x => x.id === id);
    if (!a) return json(res, 404, { error: 'not found' });
    a.feedback = ['helped', 'not-helped', null].includes(body.feedback) ? body.feedback : a.feedback;
    d.updatedAt = Date.now(); saveStore();
    return json(res, 200, { action: a });
  }

  if (req.method === 'PUT' && p === '/api/signature') {
    const body = await readBody(req);
    if (!isDeviceId(body.deviceId)) return json(res, 400, { error: 'deviceId required' });
    const s = body.signature || {};
    // Accept only the aggregate fields: anything else (dates, notes, raw values) is discarded.
    const clean = {
      dominantSymptomCombination: Array.isArray(s.dominantSymptomCombination) ? s.dominantSymptomCombination.filter(t => E.SYMPTOM_DEFS[t]).slice(0, 4) : [],
      secondaryCombinations: Array.isArray(s.secondaryCombinations) ? s.secondaryCombinations.slice(0, 3).map(c => (Array.isArray(c) ? c.filter(t => E.SYMPTOM_DEFS[t]).slice(0, 4) : [])) : [],
      cyclePhaseDistribution: Object.fromEntries(['menstrual','follicular','ovulation','luteal'].map(k => [k, Math.max(0, Math.min(1, Number((s.cyclePhaseDistribution || {})[k]) || 0))])),
      topCareActionsUsed: Array.isArray(s.topCareActionsUsed) ? s.topCareActionsUsed.filter(a => E.CARE_ACTIVITIES[a]).slice(0, 3) : [],
      topCareActionsHelped: Array.isArray(s.topCareActionsHelped) ? s.topCareActionsHelped.filter(a => E.CARE_ACTIVITIES[a]).slice(0, 3) : [],
      patternCount: Number(s.patternCount) || 0,
    };
    const d = device(body.deviceId);
    d.signature = clean; d.updatedAt = Date.now(); saveStore();
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && p === '/api/clusters') {
    const { clusters, membership, k, dropped, poolSize, realCount } = computeClusters();
    let mine = null, ranked = clusters;
    if (isDeviceId(deviceId) && store.devices[deviceId] && store.devices[deviceId].signature) {
      mine = membership[anonymize(deviceId)] || null;
      ranked = E.rankClustersFor(store.devices[deviceId].signature, clusters);
    }
    return json(res, 200, {
      clusters: ranked, myClusterId: mine, k, droppedBelowFloor: dropped, poolSize, realCount,
      privacy: {
        kFloor: k,
        note: 'Similarity is based on self-reported patterns, not clinical information. Groups under the floor are merged or hidden. Only group aggregates are ever returned.',
      },
    });
  }

  return json(res, 404, { error: 'no such route' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') return json(res, 204, {});
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`port ${PORT} is already in use (another shape server running?). Stop it or run: PORT=4178 pnpm start`);
    process.exit(1);
  }
  throw err;
});
server.listen(PORT, () => {
  console.log(`shape server: http://localhost:${PORT}  (k-floor ${K_FLOOR}, store ${path.relative(process.cwd(), STORE_PATH)})`);
  console.log(NEBIUS_API_KEY ? `support agent: ${NEBIUS_MODEL} via ${NEBIUS_BASE_URL}` : 'support agent: OFF (no NEBIUS_API_KEY in server/.env)');
  console.log(LINKUP_API_KEY ? `web search: Linkup (${LINKUP_DEPTH}) via ${LINKUP_BASE_URL}` : 'web search: OFF (no LINKUP_API_KEY in server/.env)');
});
