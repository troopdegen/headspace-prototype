# shape: prototype

"Your body has a shape." A living constellation of a person's self-reported signals, not a dashboard. Built for Claude Build Day, Universidad Iberoamericana, Fall 2026.

## Run

```bash
cd prototype/server
pnpm start            # → http://localhost:4177  (zero dependencies, Node 18+)
```

Opening `prototype/index.html` directly (file://) also works: the client falls back to device-local storage and computes community clusters locally from the synthetic population with the same engine. The header badge says which mode is active.

## Files

- `index.html`: the client. Rendering and interaction only. Canvas 2D, vanilla JS.
- `engine.js`: the shared, pure data pipeline (no DOM, no fetch). Loaded by the browser and required by the server, so pattern detection, signatures and clustering are literally the same code on both sides.
- `server/server.js`: persistence for the care layer plus k-anonymous community clustering. JSON file store in `server/data/store.json` (gitignored), device ids salted with `server/data/salt`.

## Data pipeline (engine.js)

```
Observation → Symptom / CyclePhase / ContextEvent → Relationship → Pattern → Insight → ConstellationNode
CareAction → CareNode (the "care" region at the heart of the constellation)
UserPatternSignature → SimilarityCluster → distant constellations (aggregate only)
```

- `generatePersona({ seed, cycleLengths, archetype, careProfile })`: deterministic synthetic history with an engineered co-occurrence so the pattern engine has something real to find. The demo persona (seed 90210, 2 cycles, 45 days) is unchanged from v0.
- `computeCoOccurrence(records)`: same-day co-occurrence counts for every pair of difficult signals. Feeds both `detectAllPatterns()` and the visible relationship threads.
- `detectAllPatterns(records)`: all pairs recurring on 3+ days, extended to trios when a third signal holds on exactly the same days (the trio replaces its pairs). Sorted by strength; the client shows one at a time.
- `linkCareToRecords(actions, records)` and `detectCarePatterns(actions, records)`: each care action links to the day it was reached for (trigger symptom first, then other difficult signals that day). Repeated activities with feedback become care patterns: "slow breathing helped every one of the 4 times you reached for it, on days with pelvic pain, fatigue and poor sleep, mostly in your luteal phase". These draw the care threads, enter the one-at-a-time insight queue after the first symptom pattern, and feed Understand this, the coach line and the support agent's context.
- `careReflection(actions)`: turns accumulated care actions into one observational line ("Slow breathing has helped you settle three times this cycle"). Never a claim.
- `buildSignature({ history, careActions })`: the only thing that leaves the device. Dominant combination, phase distribution of that pattern, top care actions used and reported as helping. No dates, values or text.
- `clusterSignatures(signatures, { k: 5, careFloor: 3 })`: groups by dominant combination, merges under-floor groups into their nearest neighbour, drops anything still under k, and returns only aggregates (member count, representative shape, top shared pattern, care actions at least 3 members reported as helping).

## API (server.js)

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/me?deviceId=` | The device's own care actions |
| POST | `/api/care` | Log a CareAction `{ deviceId, action: { activity, triggerContext } }` |
| PATCH | `/api/care/:id` | Set optional feedback `helped` / `not-helped` / null |
| PUT | `/api/signature` | Upload the device's aggregate signature (fields whitelisted) |
| GET | `/api/clusters?deviceId=` | k-anonymous clusters ranked by similarity, plus the caller's own cluster id |
| POST | `/api/support/chat` | Emotional-support conversation, streamed as SSE `data: {"delta"}` … `data: [DONE]` |
| GET | `/api/health` | Liveness, k floor, device count, whether the support agent is configured |

Community pool = synthetic population (60 personas across 6 archetypes, one archetype deliberately below the floor) + every real device that uploaded a signature. `K_FLOOR` and `PORT` are environment variables.

## Support agent (Talk it through)

The coach orb doubles as an emotional-support presence: a fifth branch in the support flow ("Talk it through") and a click on the orb itself. Backed by Nebius Token Factory (OpenAI-compatible) with `Qwen/Qwen3-235B-A22B-Instruct-2507` by default. The system prompt lives in `server/server.js` (`SUPPORT_SYSTEM_PROMPT`): listen and validate first, short replies, one gentle question at a time, mirror the person's language, never diagnose or give medical advice, offer low-risk ways to settle, take any mention of self-harm seriously and share Línea de la Vida 800 911 2000 (MX) / 988 (US).

The agent can look things up on the web through [Linkup](https://docs.linkup.so) (`POST /v1/search`, `sourcedAnswer`, depth `fast` by default). It is exposed to the model as a `search_web` tool via OpenAI-style function calling, restricted by the prompt to practical questions and resources (self-care practices, preparing for a doctor visit, finding support), never to diagnose. Up to two search rounds per turn; the client shows "Looking that up: …" while it runs and renders the sources as chips under the reply. Specific facts (phone numbers, services) must come from the results or the agent says it could not confirm them. Set `LINKUP_API_KEY` in `server/.env`; without it the tool is simply not offered to the model.

Configure the model key in `server/.env` (copy `.env.example`); `pnpm start` loads it via `--env-file-if-exists`. A key already exported in your shell as `NEBIUS_API_KEY` also works. Without a key the endpoint answers 503 and the client shows a graceful line instead. Each conversation logs one `talk-it-through` CareAction; transcripts are relayed to the model and never stored.

## Privacy rules enforced in code

- Raw observations never reach the server; only signatures and the device's own care actions do.
- Support conversations are relayed to the model provider (Nebius) with a short self-reported context block and are never written to the store. Search queries the model composes are sent to Linkup; the person's messages themselves are not.
- Any cluster under k is merged or dropped before anything is serialized.
- Per-member care data only surfaces when at least 3 members share it.
- The only per-person fact ever returned is the caller's own cluster id.
- Copy everywhere states that similarity is self-reported, not clinical, and never a shared diagnosis.

All health history shown is synthetic. Nothing here diagnoses.
