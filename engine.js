/* =====================================================================================
   SHAPE ENGINE: the pure data pipeline, shared by the browser client and the server.
   No DOM, no canvas, no fetch. Same code computes patterns on the device and
   signatures / clusters on the server, so "the same detectAllPatterns()" is literal.

   Observation → Symptom / CyclePhase / ContextEvent → Relationship → Pattern → Insight
                                                                     ↓
                                    CareAction → UserPatternSignature → SimilarityCluster
===================================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ShapeEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAY_MS = 86400000;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /* ---------- 0. seeded random ---------- */
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function makeRng(seed) {
    const rng = mulberry32(seed);
    const rr = (min, max) => min + rng() * (max - min);
    const ri = (min, max) => Math.floor(rr(min, max + 1));
    const chance = (p) => rng() < p;
    return { rng, rr, ri, chance };
  }

  /* ---------- 1. vocabulary ---------- */
  const Domain = { CYCLE:'CYCLE', BODY:'BODY', ENERGY:'ENERGY', MIND:'MIND', EMOTIONS:'EMOTIONS', CONTEXT:'CONTEXT', CARE:'CARE' };
  const CyclePhase = { MENSTRUAL:'menstrual', FOLLICULAR:'follicular', OVULATION:'ovulation', LUTEAL:'luteal' };

  const SYMPTOM_DEFS = {
    bleeding:          { domain: Domain.CYCLE,    label: 'Bleeding',              valence: 'rose'    },
    ovulation:         { domain: Domain.CYCLE,    label: 'Ovulation window',      valence: 'rose'    },
    pelvicPain:        { domain: Domain.BODY,     label: 'Pelvic pain',           valence: 'warm'    },
    cramps:            { domain: Domain.BODY,     label: 'Cramps',                valence: 'warm'    },
    bloating:          { domain: Domain.BODY,     label: 'Bloating',              valence: 'warm'    },
    headache:          { domain: Domain.BODY,     label: 'Headache',              valence: 'warm'    },
    digestive:         { domain: Domain.BODY,     label: 'Digestive discomfort',  valence: 'warm'    },
    breastTenderness:  { domain: Domain.BODY,     label: 'Breast tenderness',     valence: 'warm'    },
    backPain:          { domain: Domain.BODY,     label: 'Back pain',             valence: 'warm'    },
    fatigue:           { domain: Domain.ENERGY,   label: 'Fatigue',               valence: 'warm'    },
    energy:            { domain: Domain.ENERGY,   label: 'Energy',                valence: 'cool'    },
    sleep:             { domain: Domain.ENERGY,   label: 'Sleep quality',         valence: 'violet'  },
    stress:            { domain: Domain.MIND,     label: 'Stress',                valence: 'warm'    },
    anxiety:           { domain: Domain.MIND,     label: 'Anxiety',               valence: 'warm'    },
    irritability:      { domain: Domain.MIND,     label: 'Irritability',          valence: 'warm'    },
    mentalClarity:     { domain: Domain.MIND,     label: 'Mental clarity',        valence: 'cool'    },
    sadness:           { domain: Domain.EMOTIONS, label: 'Sadness',               valence: 'warm'    },
    joy:               { domain: Domain.EMOTIONS, label: 'Joy',                   valence: 'cool'    },
    sensitivity:       { domain: Domain.EMOTIONS, label: 'Emotional sensitivity', valence: 'warm'    },
    overwhelm:         { domain: Domain.EMOTIONS, label: 'Overwhelm',             valence: 'warm'    },
    exercise:          { domain: Domain.CONTEXT,  label: 'Exercise',              valence: 'neutral' },
    sex:               { domain: Domain.CONTEXT,  label: 'Intimacy',              valence: 'neutral' },
    medication:        { domain: Domain.CONTEXT,  label: 'Medication',            valence: 'neutral' },
    food:              { domain: Domain.CONTEXT,  label: 'Food / cravings',       valence: 'neutral' },
    workload:          { domain: Domain.CONTEXT,  label: 'Workload',              valence: 'neutral' },
    social:            { domain: Domain.CONTEXT,  label: 'Social activity',       valence: 'neutral' },
  };

  // Symptom types the pattern engine considers "difficult" candidates for co-occurrence.
  const CANDIDATE_TYPES = ['pelvicPain','fatigue','sleep','cramps','bloating','headache','backPain',
    'digestive','anxiety','stress','sensitivity','irritability','overwhelm','sadness'];

  /* ---------- 2. care vocabulary (Layer: CareAction) ---------- */
  // modality is the coarse family the product reasons about; activity is the concrete thing tried.
  const CARE_MODALITIES = ['understand','feel-better','acknowledge','prepare-doctor','write','draw','move','calm'];
  const CARE_ACTIVITIES = {
    'read-pattern':     { modality: 'understand',     label: 'Read what this might mean',   verb: 'reading about it' },
    'talk-it-through':  { modality: 'understand',     label: 'Talked it through',           verb: 'talking it through' },
    'acknowledge':      { modality: 'acknowledge',    label: 'Just acknowledged it',         verb: 'acknowledging it' },
    'doctor-summary':   { modality: 'prepare-doctor', label: 'Prepared a doctor summary',    verb: 'preparing for your doctor' },
    'slow-breathing':   { modality: 'calm',           label: 'Slow breathing',               verb: 'slow breathing' },
    'warm-compress':    { modality: 'calm',           label: 'Warm compress',                verb: 'warmth' },
    'rest':             { modality: 'calm',           label: 'Rest',                         verb: 'resting' },
    'gentle-movement':  { modality: 'move',           label: 'Gentle movement',              verb: 'gentle movement' },
    'write-it-out':     { modality: 'write',          label: 'Wrote it out',                 verb: 'writing it out' },
    'draw-it':          { modality: 'draw',           label: 'Drew how it feels',            verb: 'drawing it' },
  };

  function makeCareAction({ userId, activity, triggerContext, timestamp, feedback, id, synthetic }) {
    const def = CARE_ACTIVITIES[activity];
    if (!def) throw new Error('unknown care activity: ' + activity);
    return {
      id: id || ('care-' + (timestamp || Date.now()) + '-' + Math.random().toString(36).slice(2, 8)),
      userId: userId || null,
      timestamp: timestamp || Date.now(),
      triggerContext: triggerContext || { symptomType: null, patternId: null },
      modality: def.modality,
      activity,
      feedback: feedback === 'helped' || feedback === 'not-helped' ? feedback : null,
      synthetic: !!synthetic,
    };
  }

  /* ---------- 3. cycle phase ---------- */
  function phaseForCycleDay(day, length) {
    const ov = Math.max(11, length - 14);
    if (day <= 5) return CyclePhase.MENSTRUAL;
    if (day < ov) return CyclePhase.FOLLICULAR;
    if (day <= ov + 1) return CyclePhase.OVULATION;
    return CyclePhase.LUTEAL;
  }

  /* ---------- 4. synthetic persona generator (Observation → Symptom) ----------
     Deterministic per seed. `archetype` decides which engineered co-occurrence the
     persona carries so the pattern engine has something real to find. The demo
     persona (seed 90210, luteal-pain, 2 cycles) is byte-identical to v0's history. */
  const ARCHETYPES = {
    'luteal-pain':      { types: ['pelvicPain','fatigue','sleep'],      days: (len) => [len - 3, len - 2] },
    'menstrual-cramps': { types: ['cramps','backPain','fatigue'],       days: ()    => [1, 2] },
    'ovulation-head':   { types: ['headache','anxiety'],                days: (len) => { const ov = Math.max(11, len - 14); return [ov, ov + 1]; } },
    'luteal-mood':      { types: ['irritability','sensitivity','sleep'],days: (len) => [len - 5, len - 4] },
    'luteal-gut':       { types: ['bloating','digestive'],              days: (len) => [len - 7, len - 6] },
    'rare-heavy':       { types: ['overwhelm','sadness'],               days: (len) => [len - 2, len - 1] },
  };
  const SUPPRESS_ON_PATTERN_DAYS = ['cramps','bloating','headache','backPain','anxiety','sensitivity','irritability','overwhelm','sadness','digestive','stress','pelvicPain','fatigue'];

  function generatePersona({ seed = 90210, cycleLengths = [24, 21], archetype = 'luteal-pain', today, careProfile = null } = {}) {
    const R = makeRng(seed);
    const { rr, ri, chance } = R;
    const t0 = today ? new Date(today) : new Date(); t0.setHours(0, 0, 0, 0);
    const currentCycleStart = new Date(t0.getTime() - 1 * DAY_MS);

    const cycles = [];
    let cursor = new Date(currentCycleStart);
    for (let i = cycleLengths.length - 1; i >= 0; i--) {
      cursor = new Date(cursor.getTime() - cycleLengths[i] * DAY_MS);
      cycles.unshift({ start: new Date(cursor), length: cycleLengths[i], index: i });
    }
    cycles.push({ start: currentCycleStart, length: null, index: cycles.length });

    const history = [];
    cycles.forEach((cyc, ci) => {
      if (cyc.length === null) return;
      for (let day = 1; day <= cyc.length; day++) {
        const date = new Date(cyc.start.getTime() + (day - 1) * DAY_MS);
        if (date >= t0) continue;
        const phase = phaseForCycleDay(day, cyc.length);
        const rec = { date, cycleIndex: ci, cycleDay: day, length: cyc.length, phase, symptoms: {} };
        const set = (type, value) => { if (value > 0) rec.symptoms[type] = clamp(Math.round(value), 0, 10); };
        if (phase === CyclePhase.MENSTRUAL) {
          const flow = day <= 2 ? rr(6,9) : day <= 4 ? rr(3,6) : rr(1,3);
          set('bleeding', flow); set('cramps', rr(3,8)); set('pelvicPain', rr(2,6)); set('backPain', rr(1,5));
          set('fatigue', rr(4,8)); set('bloating', rr(2,6));
          if (chance(0.3)) set('digestive', rr(2,5));
          if (chance(0.5)) set('medication', rr(3,7));
          set('sleep', rr(4,7));
        } else if (phase === CyclePhase.FOLLICULAR) {
          set('energy', rr(5,9)); set('mentalClarity', rr(5,9));
          if (chance(0.45)) set('joy', rr(4,8));
          set('sleep', rr(6,9));
          if (chance(0.4)) set('exercise', rr(3,8));
          if (chance(0.15)) set('social', rr(3,7));
        } else if (phase === CyclePhase.OVULATION) {
          set('energy', rr(6,9));
          if (chance(0.55)) set('headache', rr(5,8));
          if (chance(0.5)) set('exercise', rr(4,8));
          if (chance(0.3)) set('sex', rr(3,7));
          set('sleep', rr(6,8));
        } else {
          set('bloating', rr(3,7)); set('breastTenderness', rr(2,6)); set('irritability', rr(2,6)); set('anxiety', rr(1,5));
          if (chance(0.35)) set('sadness', rr(2,5));
          if (chance(0.4)) set('sensitivity', rr(3,6));
          set('sleep', rr(3,7)); set('fatigue', rr(3,7));
          if (chance(0.3)) set('food', rr(3,7));
          if (chance(0.25)) set('workload', rr(4,8));
          if (chance(0.2)) set('overwhelm', rr(3,6));
          set('pelvicPain', rr(1,4));
        }
        history.push(rec);
      }
    });

    // Engineered, guaranteed co-occurrence on two days of each of the last two completed cycles.
    const arch = ARCHETYPES[archetype] || ARCHETYPES['luteal-pain'];
    const completed = cycles.filter(c => c.length !== null);
    const patternDays = [];
    completed.slice(-2).forEach(cyc => {
      arch.days(cyc.length).forEach(day => {
        const date = new Date(cyc.start.getTime() + (day - 1) * DAY_MS);
        const rec = history.find(h => h.date.getTime() === date.getTime());
        if (!rec) return;
        // v0 consumption order preserved for the demo persona: pelvicPain, fatigue, sleep, then suppressions.
        arch.types.forEach(type => { rec.symptoms[type] = type === 'sleep' ? ri(2,3) : (type === arch.types[0] ? ri(8,9) : ri(7,8)); });
        SUPPRESS_ON_PATTERN_DAYS.filter(t => !arch.types.includes(t))
          .forEach(t => { if (rec.symptoms[t] !== undefined) rec.symptoms[t] = ri(1,3); });
        patternDays.push(rec);
      });
    });

    // Synthetic care history (labeled synthetic) so the care layer has something to reflect in a demo.
    const careActions = [];
    if (careProfile) {
      careProfile.forEach(({ activity, times, helpedRate, onPatternDays }) => {
        for (let i = 0; i < times; i++) {
          const rec = onPatternDays && patternDays.length ? patternDays[i % patternDays.length]
                    : history[ri(0, history.length - 1)];
          const feedback = helpedRate === null ? null : (chance(helpedRate) ? 'helped' : 'not-helped');
          careActions.push(makeCareAction({
            userId: null, activity, timestamp: rec.date.getTime() + 20 * 3600000,
            triggerContext: { symptomType: arch.types[0], patternId: null }, feedback, synthetic: true,
            id: 'care-syn-' + seed + '-' + activity + '-' + i,
          }));
        }
      });
    }

    return { seed, archetype, today: t0, cycles, completed, history, patternDays, careActions };
  }

  /* ---------- 5. relationships + patterns (Layers 3–4) ---------- */
  function meetsCondition(rec, type) {
    const v = rec.symptoms[type];
    if (v === undefined) return false;
    return type === 'sleep' ? v <= 4 : v >= 6;
  }
  function pairKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }

  // Counts same-day co-occurrences of difficult signals between every pair of types.
  // `records` is whatever window the caller wants (visible range, last two cycles, ...).
  function computeCoOccurrence(records, types = CANDIDATE_TYPES) {
    const counts = new Map(); // pairKey → { a, b, count, days: [] }
    records.forEach(rec => {
      const present = types.filter(t => meetsCondition(rec, t));
      for (let i = 0; i < present.length; i++) for (let j = i + 1; j < present.length; j++) {
        const k = pairKey(present[i], present[j]);
        const e = counts.get(k) || { a: present[i], b: present[j], count: 0, days: [] };
        e.count++; e.days.push(rec); counts.set(k, e);
      }
    });
    return counts;
  }

  // Scans every pair, keeps pairs recurring on >= minDays, extends to trios when a
  // third type holds on exactly the same days; a trio replaces its constituent pairs.
  function detectAllPatterns(records, { minDays = 3, types = CANDIDATE_TYPES } = {}) {
    const pairs = [...computeCoOccurrence(records, types).values()].filter(e => e.count >= minDays);
    const patterns = [];
    const consumed = new Set();
    pairs.forEach(p => {
      const dayIds = p.days.map(d => d.date.getTime());
      types.filter(t => t !== p.a && t !== p.b).forEach(third => {
        if (!p.days.every(rec => meetsCondition(rec, third))) return;
        const trioTypes = [p.a, p.b, third].sort();
        const id = trioTypes.join('+');
        if (patterns.some(x => x.id === id)) return;
        patterns.push({ id, types: trioTypes, days: p.days.slice(), cyclesInvolved: [...new Set(p.days.map(d => d.cycleIndex))], size: 3 });
        [pairKey(p.a, p.b), pairKey(p.a, third), pairKey(p.b, third)].forEach(k => consumed.add(k + '@' + dayIds.join(',')));
      });
    });
    pairs.forEach(p => {
      const dayIds = p.days.map(d => d.date.getTime()).join(',');
      if (consumed.has(pairKey(p.a, p.b) + '@' + dayIds)) return;
      const t = [p.a, p.b].sort();
      patterns.push({ id: t.join('+'), types: t, days: p.days.slice(), cyclesInvolved: [...new Set(p.days.map(d => d.cycleIndex))], size: 2 });
    });
    // Strength: richer combination first, then recurrence, then spread across cycles.
    patterns.sort((a, b) => (b.size - a.size) || (b.days.length - a.days.length) || (b.cyclesInvolved.length - a.cyclesInvolved.length) || a.id.localeCompare(b.id));
    return patterns;
  }

  /* ---------- 6. care reflection (Layer: CareAction → observation, never a claim) ---------- */
  function careReflection(careActions, { since } = {}) {
    const from = since || 0;
    const recent = careActions.filter(a => a.timestamp >= from);
    if (!recent.length) return null;
    const helped = {};
    recent.filter(a => a.feedback === 'helped').forEach(a => { helped[a.activity] = (helped[a.activity] || 0) + 1; });
    const top = Object.entries(helped).sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= 2) {
      const n = top[1];
      const words = { 2: 'twice', 3: 'three times', 4: 'four times', 5: 'five times' };
      return { kind: 'helped', activity: top[0], count: n,
        text: `${capitalize(CARE_ACTIVITIES[top[0]].verb)} has helped you settle ${words[n] || n + ' times'} this cycle.` };
    }
    const tried = new Set(recent.map(a => a.activity));
    if (tried.size >= 2 && !recent.some(a => a.feedback)) {
      return { kind: 'tried', count: tried.size, text: "You've tried a few things lately. If any of them helped, you can tell me whenever you like." };
    }
    return null;
  }
  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  /* ---------- 6b. care ↔ symptom links and care patterns ----------
     A CareAction is reached for in a moment. We link it to that day's record: the
     trigger symptom first, then any other difficult signal reported the same day.
     Repeated (activity, symptom) links with feedback become a care pattern:
     "what helped, and with what". Observation only, never a prescription. */
  function dayKey(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }

  function linkCareToRecords(careActions, records) {
    const byDay = new Map();
    records.forEach(r => byDay.set(dayKey(r.date), r));
    const links = new Map(); // actionId → { types, phase, record }
    careActions.forEach(a => {
      const rec = byDay.get(dayKey(a.timestamp));
      const trig = a.triggerContext && a.triggerContext.symptomType;
      const types = [];
      if (trig && SYMPTOM_DEFS[trig]) types.push(trig);
      if (rec) CANDIDATE_TYPES.forEach(t => { if (t !== trig && meetsCondition(rec, t)) types.push(t); });
      links.set(a.id, { types, phase: rec ? rec.phase : null, record: rec || null });
    });
    return links;
  }

  function detectCarePatterns(careActions, records, { minTimes = 2 } = {}) {
    const links = linkCareToRecords(careActions, records);
    const tally = new Map(); // activity → stats
    careActions.forEach(a => {
      const l = links.get(a.id); if (!l) return;
      const e = tally.get(a.activity) || { id: 'care:' + a.activity, activity: a.activity, modality: a.modality, used: 0, helped: 0, notHelped: 0, actionIds: [], days: new Set(), typeTally: {}, phases: {} };
      e.used++; if (a.feedback === 'helped') e.helped++; if (a.feedback === 'not-helped') e.notHelped++;
      e.actionIds.push(a.id); e.days.add(dayKey(a.timestamp));
      l.types.forEach(t => { e.typeTally[t] = (e.typeTally[t] || 0) + 1; });
      if (l.phase) e.phases[l.phase] = (e.phases[l.phase] || 0) + 1;
      tally.set(a.activity, e);
    });
    const out = [...tally.values()].filter(e => e.used >= minTimes).map(e => {
      const floor = Math.ceil(e.used / 2);
      const symptomTypes = Object.entries(e.typeTally).filter(([, n]) => n >= floor).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([t]) => t);
      const top = Object.entries(e.phases).sort((x, y) => y[1] - x[1])[0];
      return { ...e, days: [...e.days], symptomTypes, dominantPhase: top ? top[0] : null, size: 2 };
    });
    // Strength: reported relief first, then how often it was reached for.
    out.sort((a, b) => (b.helped - a.helped) || (b.used - a.used) || a.id.localeCompare(b.id));
    return out;
  }

  /* ---------- 7. UserPatternSignature (Layer: person → anonymous aggregate) ----------
     Only aggregates leave the device: dominant combination, phase distribution, care
     tallies. No dates, no free text, no per-day values. */
  function buildSignature({ anonymizedId, history, careActions = [] }) {
    const patterns = detectAllPatterns(history);
    const dominant = patterns[0] ? patterns[0].types.slice() : [];
    const secondary = patterns.slice(1, 3).map(p => p.types.slice());
    // Where in the cycle the dominant pattern lives (falls back to all difficult days).
    const phaseTally = { menstrual: 0, follicular: 0, ovulation: 0, luteal: 0 };
    let difficultDays = 0;
    const phaseSource = patterns[0] ? patterns[0].days : history.filter(rec => CANDIDATE_TYPES.some(t => meetsCondition(rec, t)));
    phaseSource.forEach(rec => { phaseTally[rec.phase]++; difficultDays++; });
    const cyclePhaseDistribution = {};
    Object.keys(phaseTally).forEach(k => { cyclePhaseDistribution[k] = difficultDays ? +(phaseTally[k] / difficultDays).toFixed(3) : 0; });
    const used = {}, helped = {};
    careActions.forEach(a => { used[a.activity] = (used[a.activity] || 0) + 1; if (a.feedback === 'helped') helped[a.activity] = (helped[a.activity] || 0) + 1; });
    const topN = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
    return {
      anonymizedId,
      dominantSymptomCombination: dominant,
      secondaryCombinations: secondary,
      cyclePhaseDistribution,
      topCareActionsUsed: topN(used),
      topCareActionsHelped: topN(helped),
      patternCount: patterns.length,
    };
  }

  /* ---------- 8. SimilarityCluster (k-anonymous aggregation) ---------- */
  function jaccard(a, b) {
    const A = new Set(a), B = new Set(b);
    if (!A.size && !B.size) return 1;
    let inter = 0; A.forEach(x => { if (B.has(x)) inter++; });
    return inter / (A.size + B.size - inter);
  }
  const PHASES = ['menstrual','follicular','ovulation','luteal'];
  function phaseSimilarity(pa, pb) {
    let dot = 0, na = 0, nb = 0;
    PHASES.forEach(p => { const x = pa[p] || 0, y = pb[p] || 0; dot += x * y; na += x * x; nb += y * y; });
    return (na && nb) ? dot / Math.sqrt(na * nb) : 0;
  }
  function signatureSimilarity(a, b) {
    const typesA = [...a.dominantSymptomCombination, ...a.secondaryCombinations.flat()];
    const typesB = [...b.dominantSymptomCombination, ...b.secondaryCombinations.flat()];
    return 0.6 * jaccard(a.dominantSymptomCombination, b.dominantSymptomCombination)
         + 0.2 * jaccard(typesA, typesB)
         + 0.2 * phaseSimilarity(a.cyclePhaseDistribution, b.cyclePhaseDistribution);
  }
  function meanPhase(members) {
    const out = {}; PHASES.forEach(p => { out[p] = +(members.reduce((s, m) => s + (m.cyclePhaseDistribution[p] || 0), 0) / members.length).toFixed(3); });
    return out;
  }
  function mostCommonCombination(members) {
    const tally = {};
    members.forEach(m => { const k = m.dominantSymptomCombination.join('+'); tally[k] = (tally[k] || 0) + 1; });
    const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    return top && top[0] ? top[0].split('+') : [];
  }
  function hashId(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }

  // Groups signatures by dominant combination, merges under-floor groups into their
  // nearest neighbour, drops anything still under k, and returns ONLY aggregates.
  function clusterSignatures(signatures, { k = 5, careFloor = 3 } = {}) {
    const groups = new Map();
    signatures.forEach(s => {
      const key = s.dominantSymptomCombination.length ? s.dominantSymptomCombination.join('+') : '(none)';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    });
    let list = [...groups.values()];
    const summary = (members) => ({ combo: mostCommonCombination(members), phase: meanPhase(members) });
    // Merge loop: smallest under-floor group joins its most similar group.
    for (let guard = 0; guard < 100; guard++) {
      const small = list.filter(g => g.length < k).sort((a, b) => a.length - b.length)[0];
      if (!small || list.length < 2) break;
      const sSum = summary(small);
      let best = null, bestScore = -1;
      list.forEach(g => {
        if (g === small) return;
        const gs = summary(g);
        const score = 0.7 * jaccard(sSum.combo, gs.combo) + 0.3 * phaseSimilarity(sSum.phase, gs.phase);
        if (score > bestScore) { bestScore = score; best = g; }
      });
      if (!best) break;
      best.push(...small);
      list = list.filter(g => g !== small);
    }
    const dropped = list.filter(g => g.length < k).reduce((s, g) => s + g.length, 0);
    list = list.filter(g => g.length >= k);

    const membership = {}; // anonymizedId → clusterId (kept server-side, never returned in bulk)
    const clusters = list.map(members => {
      const combo = mostCommonCombination(members);
      const phase = meanPhase(members);
      const clusterId = 'cl-' + hashId(combo.join('+') + '|' + members.length);
      members.forEach(m => { membership[m.anonymizedId] = clusterId; });
      // representative shape: how much of the group's pattern vocabulary lives in each domain.
      const domainWeight = {};
      const typeTally = {};
      members.forEach(m => [...m.dominantSymptomCombination, ...m.secondaryCombinations.flat()].forEach(t => { typeTally[t] = (typeTally[t] || 0) + 1; }));
      const total = Object.values(typeTally).reduce((a, b) => a + b, 0) || 1;
      Object.entries(typeTally).forEach(([t, n]) => { const d = SYMPTOM_DEFS[t].domain; domainWeight[d] = +((domainWeight[d] || 0) + n / total).toFixed(3); });
      // care aggregate: only activities that >= careFloor members reported as helping.
      const helpedTally = {}, usedTally = {};
      members.forEach(m => { m.topCareActionsHelped.forEach(a => { helpedTally[a] = (helpedTally[a] || 0) + 1; }); m.topCareActionsUsed.forEach(a => { usedTally[a] = (usedTally[a] || 0) + 1; }); });
      const topCareActionsThatHelped = Object.entries(helpedTally).filter(([, n]) => n >= careFloor).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([activity, n]) => ({ activity, share: +(n / members.length).toFixed(2) }));
      const topCareActionsUsed = Object.entries(usedTally).filter(([, n]) => n >= careFloor).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a]) => a);
      const dominantPhase = PHASES.reduce((a, b) => (phase[a] >= phase[b] ? a : b));
      return {
        clusterId,
        memberCount: members.length,
        representativeShape: { domainWeight, links: combo, phaseDistribution: phase, dominantPhase },
        topSharedPattern: combo,
        topCareActionsThatHelped,
        topCareActionsUsed,
      };
    });
    return { clusters, membership, k, dropped };
  }

  // Ranks clusters by similarity to one signature. Output stays aggregate.
  function rankClustersFor(signature, clusters) {
    return clusters.map(c => {
      const proxy = { dominantSymptomCombination: c.topSharedPattern, secondaryCombinations: [], cyclePhaseDistribution: c.representativeShape.phaseDistribution };
      return { ...c, similarity: +signatureSimilarity(signature, proxy).toFixed(3) };
    }).sort((a, b) => b.similarity - a.similarity);
  }

  /* ---------- 9. synthetic population for the community layer ---------- */
  const POPULATION_PLAN = [
    { archetype: 'luteal-pain',      count: 18, care: [['slow-breathing', 4, 0.8], ['warm-compress', 3, 0.7], ['rest', 2, 0.5]] },
    { archetype: 'menstrual-cramps', count: 14, care: [['warm-compress', 4, 0.85], ['gentle-movement', 2, 0.4], ['rest', 3, 0.6]] },
    { archetype: 'ovulation-head',   count: 9,  care: [['rest', 3, 0.7], ['slow-breathing', 2, 0.5], ['write-it-out', 1, 0.5]] },
    { archetype: 'luteal-mood',      count: 11, care: [['write-it-out', 4, 0.75], ['slow-breathing', 3, 0.6], ['draw-it', 2, 0.5]] },
    { archetype: 'luteal-gut',       count: 5,  care: [['gentle-movement', 3, 0.7], ['rest', 2, 0.5]] },
    { archetype: 'rare-heavy',       count: 3,  care: [['acknowledge', 3, null], ['write-it-out', 2, 0.6]] }, // below floor on purpose
  ];
  function generatePopulation({ today, seedBase = 1000 } = {}) {
    const people = [];
    let seed = seedBase;
    POPULATION_PLAN.forEach(plan => {
      for (let i = 0; i < plan.count; i++) {
        seed += 7919;
        const careProfile = plan.care.map(([activity, times, helpedRate]) => ({ activity, times, helpedRate, onPatternDays: true }));
        const persona = generatePersona({ seed, archetype: plan.archetype, cycleLengths: [27, 26, 25], today, careProfile });
        people.push({ anonymizedId: 'syn-' + hashId('persona-' + seed), persona, planArchetype: plan.archetype });
      }
    });
    return people;
  }

  return {
    DAY_MS, clamp, makeRng, mulberry32,
    Domain, CyclePhase, SYMPTOM_DEFS, CANDIDATE_TYPES,
    CARE_MODALITIES, CARE_ACTIVITIES, makeCareAction,
    phaseForCycleDay, ARCHETYPES, generatePersona,
    meetsCondition, computeCoOccurrence, detectAllPatterns,
    careReflection, dayKey, linkCareToRecords, detectCarePatterns, buildSignature, signatureSimilarity, clusterSignatures, rankClustersFor,
    POPULATION_PLAN, generatePopulation, hashId,
  };
});
