# shape: prototype

"Your body has a shape." A living constellation of a person's self-reported signals, not a dashboard. Built for Claude Build Day, Universidad Iberoamericana, Fall 2026.

Static client + Vercel Functions, no framework, no build step. Persistence is a small Redis-shaped KV store (Vercel's Upstash integration), so there is no local disk to manage and no long-running process to keep alive.

## Deploy (Vercel)

1. Import this repo at [vercel.com/new](https://vercel.com/new). No framework preset needed; Vercel serves `index.html`/`engine.js` as static files and picks up everything under `api/` automatically.
2. Add persistence: in the project's **Storage** tab, add the **Upstash for Redis** integration and connect it to this project. Vercel injects `KV_REST_API_URL` and `KV_REST_API_TOKEN` for you; no code change needed.
3. Add the model keys under **Settings → Environment Variables**:
   - `NEBIUS_API_KEY` (required for the support agent)
   - `LINKUP_API_KEY` (optional, enables web search inside the support agent)
4. Deploy. `/api/health` should report `"storage": "kv"`, `"support": true`.

## Local development

```bash
pnpm dlx vercel login        # once
vercel link                  # link this directory to the Vercel project
vercel env pull .env.local   # pulls KV_REST_API_URL/TOKEN + your other env vars
pnpm dev                     # = vercel dev, http://localhost:3000
```

Without a linked project, `index.html` still opens directly (`file://`) and the client falls back to `localStorage` plus locally computed community clusters, using the exact same `engine.js`. That fallback is also what kicks in if the KV store or model keys aren't configured yet, so the app is never blank.

## Files

- `index.html`: the client. Rendering and interaction only. Canvas 2D, vanilla JS.
- `engine.js`: the shared, pure data pipeline (no DOM, no fetch, no Vercel-specific code). Loaded by the browser as a plain `<script>` global (`window.ShapeEngine`) and by the API functions via `lib/engine.mjs`, so pattern detection, care patterns, signatures and clustering are the same code everywhere.
- `lib/engine.mjs`: a one-line ESM bridge (`createRequire`) that lets the `/api` functions `import` the CommonJS `engine.js` unchanged.
- `lib/kv.js` / `.mjs`: zero-dependency Upstash Redis REST client plus the device store built on it (`getDevice`, `appendCareAction`, `setCareFeedback`, `setSignature`, `listSignatures`, salted `anonymize`).
- `lib/agent.mjs`: the emotional-support agent (system prompt, the `search_web` tool, and the Nebius streaming loop). Framework-free (`emit(event)` callback), so it doesn't care whether the caller is a Vercel `ReadableStream` or something else.
- `api/*.mjs`: one file per route (see table below). Framework-agnostic Vercel Functions: plain `export async function GET/POST/PATCH/PUT(request)` returning a Web-standard `Response`. No Next.js, no Express.

All `api/` and `lib/*.mjs` files are ESM (`import`/`export`); `engine.js` itself stays CommonJS/UMD on purpose so the browser can keep loading it as a plain global.

## Data pipeline (engine.js)

```
Observation → Symptom / CyclePhase / ContextEvent → Relationship → Pattern → Insight → ConstellationNode
CareAction → CareNode (the "care" region at the heart of the constellation)
UserPatternSignature → SimilarityCluster → distant constellations (aggregate only)
```

- `generatePersona({ seed, cycleLengths, archetype, careProfile })`: deterministic synthetic history with an engineered co-occurrence so the pattern engine has something real to find.
- `computeCoOccurrence(records)` / `detectAllPatterns(records)`: same-day co-occurrence counts for every pair of difficult signals, extended to trios when a third signal holds on exactly the same days. Sorted by strength; the client shows one at a time.
- `linkCareToRecords(actions, records)` / `detectCarePatterns(actions, records)`: each care action links to the day it was reached for (trigger symptom first, then other difficult signals that day). Repeated activities with feedback become care patterns: "slow breathing helped every one of the 4 times you reached for it, on days with pelvic pain, fatigue and poor sleep, mostly in your luteal phase." These draw the care threads, enter the insight queue, and feed Understand this / the coach / the support agent's context.
- `buildSignature({ history, careActions })`: the only thing that ever leaves the device. Dominant combination, phase distribution of that pattern, top care actions used and reported as helping. No dates, values or text.
- `clusterSignatures(signatures, { k: 5, careFloor: 3 })`: groups by dominant combination, merges under-floor groups into their nearest neighbour, drops anything still under k, and returns only aggregates.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Liveness, storage backend, whether the support agent and search are configured |
| GET | `/api/me?deviceId=` | The device's own care actions |
| POST | `/api/care` | Log a CareAction `{ deviceId, action: { activity, triggerContext } }` |
| PATCH | `/api/care` | Set optional feedback `{ deviceId, actionId, feedback: 'helped' \| 'not-helped' \| null }` |
| PUT | `/api/signature` | Upload the device's aggregate signature (fields whitelisted server-side) |
| GET | `/api/clusters?deviceId=` | k-anonymous clusters ranked by similarity, plus the caller's own cluster id |
| POST | `/api/support/chat` | Emotional-support conversation, streamed as SSE: `data: {"delta"}` … `data: [DONE]` |

Community pool = synthetic population (60 personas across 6 archetypes, one archetype deliberately below the floor) + every real device that has uploaded a signature. `K_FLOOR` is an optional env var (default 5).

## Support agent (Talk it through)

The coach orb doubles as an emotional-support presence: a fifth branch in the support flow ("Talk it through") and a click on the orb itself. Backed by Nebius Token Factory (OpenAI-compatible) with `Qwen/Qwen3-235B-A22B-Instruct-2507` by default. The system prompt lives in `lib/agent.mjs`: listen and validate first, short replies, one gentle question at a time, mirror the person's language, never diagnose or give medical advice, offer low-risk ways to settle, take any mention of self-harm seriously and share Línea de la Vida 800 911 2000 (MX) / 988 (US).

The agent can look things up on the web through [Linkup](https://docs.linkup.so) (`POST /v1/search`, `sourcedAnswer`, depth `fast` by default), exposed as a `search_web` tool via OpenAI-style function calling and restricted by the prompt to practical questions and resources, never to diagnose. Up to two search rounds per turn; the client shows "Looking that up: …" while it runs and renders the sources as chips under the reply. Specific facts (phone numbers, services) must come from the results or the agent says it could not confirm them.

Set `NEBIUS_API_KEY` (required) and `LINKUP_API_KEY` (optional) as environment variables. Without `NEBIUS_API_KEY` the endpoint answers 503 and the client shows a graceful line instead. Each conversation logs one `talk-it-through` CareAction; transcripts are relayed to the model provider and never stored.

## Privacy rules enforced in code

- Raw observations never reach the backend; only the device's own care actions and its aggregate signature do.
- Any cluster under k is merged or dropped before anything is serialized.
- Per-member care data only surfaces when at least 3 members share it.
- The only per-person fact ever returned is the caller's own cluster id.
- Support conversations are relayed to the model provider (Nebius) with a short self-reported context block and are never written to storage. Search queries the model composes are sent to Linkup; the person's messages themselves are not.
- Copy everywhere states that similarity is self-reported, not clinical, and never a shared diagnosis.

All health history shown is synthetic. Nothing here diagnoses.
