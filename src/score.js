// §7 — dead zone, regimes, severity. All code-side. Raw Noul values in, no
// normalisation: normalising would erase the multi-yes signal that is the point.

/**
 * Selection stance (§15.4). `recall` flags more and reviews more; `precision`
 * flags less and misses more. The stance IS the threshold pair, so it is stated
 * explicitly in every result rather than hidden in a constant.
 */
export const STANCES = {
  recall: { HIGH: 0.60, LOW: 0.35, EXIT_HIGH: 0.52, label: 'favour recall' },
  precision: { HIGH: 0.72, LOW: 0.45, EXIT_HIGH: 0.66, label: 'favour precision' },
};

export const DEFAULT_STANCE = 'recall';

export function thresholds(stance = DEFAULT_STANCE, overrides) {
  const base = STANCES[stance] ?? STANCES[DEFAULT_STANCE];
  return { stance, ...base, ...(overrides ?? {}) };
}

export const REGIME = {
  AMBIGUOUS: 'ambiguous',
  UNAMBIGUOUS: 'unambiguous',
  UNDERSPECIFIED: 'underspecified',
  UNCERTAIN: 'uncertain',
  CLEAN: 'clean',
  // Not a verdict about the text. The request failed, so nothing was measured;
  // this must never be rendered as "needs review", which is a claim about the
  // clause rather than about the pipeline.
  ERROR: 'error',
};

/** Three-outcome classifier for one reading (§7). */
export function verdictFor(noul, t) {
  if (noul >= t.HIGH) return 'high';
  if (noul <= t.LOW) return 'low';
  return 'inconclusive';
}

/**
 * Normalised Shannon entropy of a raw Noul vector.
 *
 * The vector is not a probability distribution — that is the whole point of using
 * absolute Nouls — so the weights used for the entropy term are the raw values over
 * their own sum, and the *magnitude* information that this step would throw away is
 * re-introduced by `severityOf` below. Entropy alone answers "how evenly forked",
 * never "how strongly".
 */
export function normalisedEntropy(values) {
  const v = values.filter((x) => Number.isFinite(x) && x > 0);
  if (v.length < 2) return 0;
  const total = v.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  let h = 0;
  for (const x of v) {
    const p = x / total;
    if (p > 0) h -= p * Math.log2(p);
  }
  return h / Math.log2(v.length);
}

/**
 * Severity for one axis.
 *
 *   severity = sqrt( normalisedEntropy(raw) x secondHighestRaw )
 *
 * The entropy term says how evenly the readings are forked; the second-highest raw
 * Noul says whether the weaker side of the fork is actually lit. Both must be large
 * for the clause to be severely ambiguous, so two evenly matched *dim* readings
 * (entropy 1.0, no real fork) score low. Reproduces the §9 worked example:
 * 0.71 / 0.66 -> 0.81.
 */
export function severityOf(values) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => b - a);
  if (sorted.length < 2) return 0;
  const second = sorted[1];
  return round(Math.sqrt(normalisedEntropy(sorted) * Math.max(second, 0)));
}

/**
 * Score one clause from its raw readings.
 *
 * @param {{text:string}} clause
 * @param {Array<{id:string, axis:string, label:string, noul:number}>} readings
 * @param {{firedAxes?:object[], stance?:string, thresholds?:object, previous?:object}} ctx
 */
export function scoreClause(clause, readings, ctx = {}) {
  const t = ctx.thresholds ?? thresholds(ctx.stance);
  const lanes = new Map((ctx.firedAxes ?? []).map((a) => [a.id, a.lane ?? 'interpretation']));

  const scored = readings.map((r) => {
    const noul = clampNoul(r.noul);
    return {
      ...r,
      noul,
      verdict: verdictFor(noul, t),
      lit: isLit(r, noul, t, ctx.previous),
      lane: lanes.get(r.axis) ?? (r.axis === 'vagueness' ? 'vagueness' : 'interpretation'),
    };
  });

  // Group by axis, keeping the fired order.
  const axes = [];
  for (const r of scored) {
    let axis = axes.find((a) => a.id === r.axis);
    if (!axis) {
      const meta = (ctx.firedAxes ?? []).find((a) => a.id === r.axis);
      axis = {
        id: r.axis,
        label: meta?.label ?? r.axis,
        trigger: meta?.trigger ?? null,
        lane: r.lane,
        readings: [],
      };
      axes.push(axis);
    }
    axis.readings.push(r);
  }

  for (const axis of axes) {
    const values = axis.readings.map((r) => r.noul);
    const highs = axis.readings.filter((r) => r.verdict === 'high');
    const inconclusive = axis.readings.filter((r) => r.verdict === 'inconclusive');
    axis.highCount = highs.length;
    axis.inconclusiveCount = inconclusive.length;
    axis.entropy = round(normalisedEntropy(values));
    axis.severity = axis.lane === 'vagueness' ? round(Math.max(...values, 0)) : severityOf(values);
    // The multi-yes signature: two readings of the SAME axis both answering yes.
    axis.forked = axis.lane === 'interpretation' && highs.length >= 2;
    axis.resolved = axis.lane === 'interpretation'
      && highs.length === 1
      && axis.readings.every((r) => r.verdict === 'high' || r.verdict === 'low');
    axis.top = [...axis.readings].sort((a, b) => b.noul - a.noul);
  }

  const interpretation = axes.filter((a) => a.lane === 'interpretation');
  const vagueness = axes.filter((a) => a.lane === 'vagueness');
  const forked = interpretation.filter((a) => a.forked).sort((a, b) => b.severity - a.severity);
  const vagueHigh = vagueness.filter((a) => a.readings.some((r) => r.verdict === 'high'));

  let regime;
  if (forked.length) {
    regime = REGIME.AMBIGUOUS;
  } else if (vagueHigh.length) {
    // §9 clause 3: obligation can still be cleanly HIGH here. What makes the clause
    // underspecified is the absence of a *fork*, not the absence of any lit reading.
    regime = REGIME.UNDERSPECIFIED;
  } else if (interpretation.length === 0) {
    regime = REGIME.CLEAN;
  } else if (interpretation.every((a) => a.resolved)) {
    regime = REGIME.UNAMBIGUOUS;
  } else {
    // Readings sit in the dead zone. Never silently passed (§7).
    regime = REGIME.UNCERTAIN;
  }

  const primary = forked[0]
    ?? vagueHigh[0]
    ?? [...interpretation].sort((a, b) => b.severity - a.severity)[0]
    ?? null;

  const secondary = forked.slice(1).concat(
    interpretation.filter((a) => !a.forked && a.inconclusiveCount > 0 && a !== primary),
  );

  return {
    clause: clause.text,
    id: clause.id,
    section: clause.section ?? null,
    line: clause.line ?? null,
    regime,
    severity: regime === REGIME.AMBIGUOUS ? primary?.severity ?? 0 : regime === REGIME.UNDERSPECIFIED ? primary?.severity ?? 0 : 0,
    primaryAxis: primary?.id ?? null,
    axes,
    secondary: secondary.map((a) => a.id),
    thresholds: { HIGH: t.HIGH, LOW: t.LOW, EXIT_HIGH: t.EXIT_HIGH, stance: t.stance },
    // §7 trust boundary, carried in the payload so no renderer can forget it.
    trust: 'comparative only; absolute Nouls are not probabilities',
  };
}

/**
 * Asymmetric hysteresis (§8): a beam that lit at >= HIGH only extinguishes below
 * EXIT_HIGH, so a reading sitting on the boundary does not strobe.
 */
function isLit(reading, noul, t, previous) {
  const was = previous?.lit?.[reading.id] ?? false;
  if (was) return noul >= t.EXIT_HIGH;
  return noul >= t.HIGH;
}

export function clampNoul(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function round(x) {
  return Math.round(x * 100) / 100;
}

/** Roll up a document's clause results for the §9 report header. */
export function summarise(results) {
  const counts = { ambiguous: 0, underspecified: 0, uncertain: 0, clear: 0, failed: 0 };
  for (const r of results) {
    if (r.regime === REGIME.ERROR) counts.failed++;
    else if (r.regime === REGIME.AMBIGUOUS) counts.ambiguous++;
    else if (r.regime === REGIME.UNDERSPECIFIED) counts.underspecified++;
    else if (r.regime === REGIME.UNCERTAIN) counts.uncertain++;
    else counts.clear++;
  }
  return { clauses: results.length, ...counts };
}
