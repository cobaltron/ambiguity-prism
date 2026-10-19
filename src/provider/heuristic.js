// Offline stand-in judge.
//
// THIS IS NOT A MODEL AND MAKES NO CLAIM TO BE ONE. It is a small rule table that
// returns plausible per-reading values from surface cues so that the mechanism, the
// CLI, the tests and the collapse animation all run with no key and no network.
//
// It exists for three reasons:
//   1. jev-1.13.0 could not be reached at build time, so the pipeline needed a
//      second provider to be developed and tested against at all.
//   2. §12 offers "canned responses for the stage" as a legitimate demo path.
//   3. Thresholds calibrated against this provider mean NOTHING about Jev. Any
//      number this file produces is marked `synthetic: true` all the way out to the
//      UI, which shows a banner, and `prism calibrate` refuses to fit on it.
//
// Where a clause matches a §9 worked example, the documented values are returned
// verbatim so the reference output is reproducible.

const WORKED_EXAMPLES = [
  {
    match: /retry failed requests up to three times before returning an error/i,
    nouls: { boundary_extra: 0.71, boundary_total: 0.66, oblig_mandatory: 0.44, oblig_optional: 0.63 },
  },
  {
    // §9 clause 2. The design doc also lists reference readings for this clause,
    // but the clause contains no pronoun and only one prior candidate noun, so the
    // reference axis correctly does not fire; only the obligation values apply.
    // See README "Deviations from the design doc".
    match: /return HTTP status 404 when the requested resource does not exist/i,
    nouls: { oblig_mandatory: 0.93, oblig_optional: 0.05 },
  },
  {
    match: /respond quickly to user actions/i,
    nouls: { oblig_mandatory: 0.90, oblig_optional: 0.08, vague_term: 0.88 },
  },
];

export function createHeuristicProvider(opts = {}) {
  const latencyMs = opts.latencyMs ?? 0; // set ~180 to feel like the real flow band
  return {
    name: 'heuristic',
    model: 'heuristic-offline',
    synthetic: true,
    requiresKey: false,
    hasKey: true,

    async evaluate(clause, readings, ctx = {}) {
      if (latencyMs) await jitterSleep(latencyMs, ctx.signal);
      const canned = WORKED_EXAMPLES.find((w) => w.match.test(clause))?.nouls ?? null;
      const nouls = {};
      for (const r of readings) {
        const value = canned && r.id in canned ? canned[r.id] : judge(clause, r);
        nouls[r.id] = clamp(value);
      }
      return { nouls, model: 'heuristic-offline', latencyMs, synthetic: true };
    },
  };
}

/** @returns {number} a plausible absolute value for one reading. */
function judge(clause, reading) {
  // Punctuation is flattened to spaces so the space-delimited cue patterns below
  // match at a clause boundary too (", or both." must hit / or both /). The slash
  // is kept so "and/or" survives.
  const c = ' ' + clause.toLowerCase().replace(/[^a-z0-9\/]+/g, ' ').trim() + ' ';
  const base = RULES[reading.id.replace(/^ref_\d+$/, 'ref')] ?? byAxis[reading.axis] ?? (() => 0.5);
  const value = base(c, reading, clause);
  // Deterministic jitter so sibling readings do not look suspiciously identical.
  return value + (hash01(clause + '|' + reading.id) - 0.5) * 0.04;
}

const FORK = 0.63;   // a reading the clause genuinely supports
const DIM = 0.08;    // a reading the clause rules out
const STRONG = 0.91; // the surviving reading once the author disambiguates

const RULES = {
  // Boundary: the author collapses the fork by saying "in total" or "in addition".
  boundary_extra: (c) => {
    if (/ in total | total attempts | including the (?:first|initial|original) | counting the (?:first|initial) /.test(c)) return DIM;
    if (/ in addition to | after the (?:first|initial|original) | additional (?:attempts?|retries) | plus the (?:first|initial) /.test(c)) return STRONG;
    return FORK + 0.08;
  },
  boundary_total: (c) => {
    if (/ in total | total attempts | including the (?:first|initial|original) | counting the (?:first|initial) /.test(c)) return STRONG;
    if (/ in addition to | after the (?:first|initial|original) | additional (?:attempts?|retries) | plus the (?:first|initial) /.test(c)) return DIM;
    return FORK + 0.03;
  },
  boundary_inclusive: (c) => (/ inclusive | and including /.test(c) ? STRONG : / exclusive /.test(c) ? DIM : FORK),
  boundary_exclusive: (c) => (/ exclusive /.test(c) ? STRONG : / inclusive | and including /.test(c) ? DIM : FORK - 0.05),

  // Obligation: the RFC-2119 word settles it, except for the hedges.
  oblig_mandatory: (c) => {
    if (/ must | shall | is required to | required to /.test(c)) return 0.93;
    if (/ may | optional | at the discretion /.test(c)) return 0.22;
    if (/ should | ought to | is encouraged /.test(c)) return 0.44;
    if (/ will | is to /.test(c)) return 0.68;
    return 0.40;
  },
  oblig_optional: (c) => {
    if (/ must | shall | is required to | required to /.test(c)) return 0.05;
    if (/ may | optional | at the discretion /.test(c)) return 0.86;
    if (/ should | ought to | is encouraged /.test(c)) return 0.63;
    if (/ will | is to /.test(c)) return 0.38;
    return 0.52;
  },

  // Coordination.
  coord_inclusive: (c) => {
    if (/ or both | and\/or | any combination /.test(c)) return STRONG;
    if (/ but not both | exactly one of | either .* or .* but not /.test(c)) return DIM;
    return FORK;
  },
  coord_exclusive: (c) => {
    if (/ but not both | exactly one of /.test(c)) return STRONG;
    if (/ or both | and\/or | any combination /.test(c)) return DIM;
    if (/ either /.test(c)) return FORK + 0.1;
    return FORK - 0.02;
  },

  // Quantifier scope. Three surface cues, in priority order: an explicit "only"
  // or "without exception" settles it; a comma before the relative pronoun marks a
  // non-restrictive clause (wide); and "all"/"any" over a restrictive clause is the
  // genuinely forked case, while "each"/"every" over one reads narrow.
  quant_wide: (c) => {
    if (/ only (?:those|the) | restricted to | limited to /.test(c)) return DIM;
    if (/ without exception | in all cases | regardless of /.test(c)) return STRONG;
    if (/,\s*(?:which|who)\b/.test(c)) return STRONG;
    return / all | any /.test(c) ? FORK + 0.04 : 0.30;
  },
  quant_narrow: (c) => {
    if (/ only (?:those|the) | restricted to | limited to /.test(c)) return STRONG;
    if (/ without exception | in all cases | regardless of /.test(c)) return DIM;
    if (/,\s*(?:which|who)\b/.test(c)) return 0.25;
    return / all | any /.test(c) ? FORK : 0.88;
  },

  // Modifier attachment: a hyphen is the author's disambiguation.
  // Uses the RAW clause: `c` has had its hyphens flattened to spaces, and the
  // author's hyphen is exactly the disambiguation this rule looks for.
  attach_near: (c, r, raw) => (hyphenated(raw, r) ? STRONG : FORK + 0.04),
  attach_far: (c, r, raw) => (hyphenated(raw, r) ? DIM : FORK),

  // Reference: the pronoun sits nearest the last candidate, which is the default
  // reading, but a competing candidate stays lit while the pronoun is unresolved.
  ref: (c, r) => {
    const idx = Number(r.id.split('_')[1] ?? 0);
    const ladder = [0.62, 0.78, 0.55];
    return ladder[idx] ?? 0.5;
  },

  // Vagueness: fires only when no threshold is present, so it is high by construction.
  vague_term: () => 0.88,
};

const byAxis = {
  // Reviewed offline proposals have no rule table; treat them as undecided so they
  // land in the dead zone rather than inventing a fork.
  proposed: () => 0.45,
};

function hyphenated(raw, reading) {
  const mod = (reading.label.match(/"([^"]+)"/)?.[1] ?? '').toLowerCase();
  return mod ? String(raw).toLowerCase().includes(mod + '-') : false;
}

function clamp(x) {
  return Math.min(1, Math.max(0, Math.round(x * 1000) / 1000));
}

/** Stable 0..1 from a string. */
function hash01(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

function jitterSleep(ms, signal) {
  const wait = ms * (0.7 + Math.random() * 0.6);
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, wait);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error('aborted'));
    }, { once: true });
  });
}
