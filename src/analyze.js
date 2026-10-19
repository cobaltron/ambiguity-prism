// Orchestrator: segment -> route -> one batched Noul call per clause -> score.
// Shared by the CLI and the proxy, so the headless mechanism and the UI can never
// drift apart.

import { segment, segmentLine } from './segment.js';
import { route } from './route.js';
import { scoreClause, summarise, thresholds, clampNoul } from './score.js';
import { cacheKey, createNullCache, sha } from './cache.js';

const DEFAULT_CONCURRENCY = 6; // §12: cap client concurrency, rely on SDK backoff

/**
 * Analyze one clause.
 * @param {{text:string,id?:string,section?:string|null,line?:number}} clause
 * @param {object} provider
 * @param {object} [opts]
 */
export async function analyzeClause(clause, provider, opts = {}) {
  const t = opts.thresholds ?? thresholds(opts.stance);
  const cache = opts.cache ?? createNullCache();
  // Dismissals merge three scopes: the whole document ('*'), the clause id, and
  // the clause's content hash (which is how the persistent review store keys them,
  // so that editing a clause revokes its dismissals along with its acceptance).
  const dismissed = [
    ...(opts.dismissed?.['*'] ?? []),
    ...(opts.dismissed?.[clause.id] ?? []),
    ...(opts.dismissed?.[sha(clause.text.trim())] ?? []),
  ];

  const routed = route(clause.text, { dismissed, proposals: opts.proposals });

  if (!routed.readings.length) {
    // No axis fired: nothing was asked, so nothing is claimed. This is an honest
    // "no applicable reading", not a clean bill of health.
    return {
      ...scoreClause(clause, [], { firedAxes: [], thresholds: t, previous: opts.previous }),
      regime: 'clean',
      noAxisFired: true,
      accepted: Boolean(opts.review?.isAccepted(clause.text)),
      dismissedAxes: dismissed,
      lint: routed.lint,
      readings: [],
      cost: { readings: 0, cached: false },
    };
  }

  const key = cacheKey(provider.model, clause.text, routed.readings);
  let payload = cache.get(key);
  const cached = Boolean(payload);
  if (cached) cache.stats.hits++;
  else {
    cache.stats.misses++;
    payload = await provider.evaluate(clause.text, routed.readings, { signal: opts.signal });
    cache.set(key, payload);
  }

  const readings = routed.readings.map((r) => ({
    id: r.id,
    axis: r.axis,
    label: r.label,
    instructions: r.instructions,
    noul: clampNoul(payload.nouls[r.id]),
    missing: !(r.id in payload.nouls),
  }));

  const scored = scoreClause(clause, readings, {
    firedAxes: routed.firedAxes,
    thresholds: t,
    previous: opts.previous,
  });

  return {
    ...scored,
    readings,
    // Reviewed-and-accepted clauses still carry their full scoring; the renderer
    // decides whether to show them. Acceptance never suppresses the measurement.
    accepted: Boolean(opts.review?.isAccepted(clause.text)),
    dismissedAxes: dismissed,
    lint: routed.lint,
    skippedAxes: routed.skipped,
    truncated: routed.truncated,
    model: payload.model,
    synthetic: Boolean(payload.synthetic),
    cost: {
      readings: routed.readings.length,
      cached,
      latencyMs: cached ? 0 : payload.latencyMs ?? null,
      // §12: ~220 tokens/clause at $0.042 per million input tokens, output free.
      // Jev reports usage.input_tokens, so prefer the real count and fall back to
      // the character estimate only when the provider does not report one.
      estTokens: cached ? 0 : payload.usage?.input_tokens ?? estimateTokens(clause.text, routed.readings),
      tokensMeasured: Boolean(!cached && payload.usage?.input_tokens),
    },
  };
}

/** Analyze a whole document with bounded concurrency. */
export async function analyzeDocument(doc, provider, opts = {}) {
  const clauses = (opts.single ? segmentLine(doc) : segment(doc))
    .filter((c) => (opts.requirementsOnly ? c.isRequirement : true));

  const results = new Array(clauses.length);
  const limit = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  let next = 0;
  const errors = [];

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= clauses.length) return;
      try {
        results[i] = await analyzeClause(clauses[i], provider, opts);
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        errors.push({ clause: clauses[i].id, error: err.message });
        results[i] = {
          ...scoreClause(clauses[i], [], { firedAxes: [], thresholds: opts.thresholds ?? thresholds(opts.stance) }),
          // 'error', never 'uncertain': the request failed, so nothing was measured
          // about this clause. Reporting it as a dead-zone verdict would be a claim
          // about the author's sentence that we did not earn.
          regime: 'error',
          error: err.message,
          readings: [],
        };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, clauses.length) }, worker));

  const clean = results.filter(Boolean);
  const totals = clean.reduce(
    (acc, r) => {
      acc.readings += r.cost?.readings ?? 0;
      acc.tokens += r.cost?.estTokens ?? 0;
      acc.cached += r.cost?.cached ? 1 : 0;
      return acc;
    },
    { readings: 0, tokens: 0, cached: 0 },
  );

  return {
    clauses: clean,
    summary: summarise(clean),
    errors,
    model: provider.model,
    synthetic: clean.some((r) => r.synthetic),
    stance: (opts.thresholds ?? thresholds(opts.stance)).stance,
    cost: { ...totals, usd: round6((totals.tokens / 1e6) * 0.042) },
    // §13: the honest one-line disclosure travels with every output.
    disclosure: 'detects interpretation ambiguity only; recall is bounded by the enumerated reading set',
  };
}

function estimateTokens(clause, readings) {
  const chars = clause.length + readings.reduce((a, r) => a + r.instructions.length, 0);
  return Math.ceil(chars / 4);
}

function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}
