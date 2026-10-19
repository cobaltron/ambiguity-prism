// §10 — validation. "This clause is ambiguous" is checkable, unlike most Jev demos.
//
//   1. A small gold set of sentences labelled ambiguous vs clear.
//   2. Fit HIGH / LOW on ONE half. Score the OTHER half only.
//   3. Headline the RECALL, because a missed reading is a missed ambiguity.
//
// The gold set shipped in fixtures/goldset.json is hand-written by the author of
// this build. It is a smoke test for the pipeline, NOT a benchmark: it is small,
// it was written by someone who knew what the detector looks for, and it has not
// been cross-checked by a second annotator. §10 names linguistics garden-path and
// requirements-engineering ambiguity corpora as leads; those were unverified in the
// design doc and are still unverified here. Treat any number below as provisional.

import { analyzeClause } from './analyze.js';
import { thresholds, scoreClause, verdictFor } from './score.js';
import { route } from './route.js';

/**
 * @param {{items: Array<{text:string,label:'ambiguous'|'clear',axis?:string}>}} gold
 * @param {object} provider
 */
export async function calibrate(gold, provider, opts = {}) {
  const items = (gold.items ?? gold).filter((x) => x && x.text && x.label);
  if (items.length < 8) throw new Error('gold set too small to split: need at least 8 items');

  if (provider.synthetic && !opts.allowSynthetic) {
    throw new Error(
      'Refusing to calibrate against the offline stand-in judge: thresholds fitted on\n' +
      'rule-table output would be thresholds for the rule table, not for Jev. Set\n' +
      'TYPESAFE_API_KEY, or pass --allow-synthetic to exercise the plumbing only.',
    );
  }

  // Deterministic, stratified split so both halves carry both labels.
  const { fit, held } = split(items, opts.seed ?? 1);

  // Each item is evaluated ONCE, at raw-Noul level. Thresholds are applied
  // afterwards, so the sweep never needs to re-query.
  const evaluated = new Map();
  for (const item of items) {
    evaluated.set(item, await rawFor(item, provider, opts));
  }

  const grid = [];
  for (let high = 0.45; high <= 0.85; high += 0.01) {
    for (let low = 0.15; low <= high - 0.05; low += 0.01) {
      const t = { HIGH: round2(high), LOW: round2(low), EXIT_HIGH: round2(high - 0.08), stance: 'fitted' };
      grid.push({ t, score: evaluate(fit, evaluated, t) });
    }
  }

  // Selection rule, stated rather than implied (§15.4): maximise F-beta with
  // beta = 2, which weights recall over precision because a missed ambiguity is
  // the costly error. Ties break toward the higher recall, then the wider dead zone.
  const ranked = grid
    .filter((g) => g.score.recall > 0)
    .sort((a, b) =>
      b.score.fbeta2 - a.score.fbeta2 ||
      b.score.recall - a.score.recall ||
      (b.t.HIGH - b.t.LOW) - (a.t.HIGH - a.t.LOW));

  const best = ranked[0];
  if (!best) throw new Error('no threshold pair separated the fit half at all');

  const heldScore = evaluate(held, evaluated, best.t);
  const defaultScore = evaluate(held, evaluated, thresholds('recall'));

  return {
    n: items.length,
    fitN: fit.length,
    heldN: held.length,
    model: provider.model,
    synthetic: Boolean(provider.synthetic),
    fitted: best.t,
    fitHalf: best.score,
    heldHalf: heldScore,
    shippedDefault: { thresholds: thresholds('recall'), heldHalf: defaultScore },
    perItem: held.map((item) => ({
      text: item.text,
      label: item.label,
      predicted: predict(evaluated.get(item), best.t),
      axis: item.axis ?? null,
    })),
    caveat: 'hand-written gold set, single annotator, no external corpus; provisional',
  };
}

/** Raw readings for one gold item, grouped per axis, provider-cached. */
async function rawFor(item, provider, opts) {
  const routed = route(item.text);
  if (!routed.readings.length) return { readings: [], firedAxes: [] };
  const analysed = await analyzeClause(
    { id: 'g', text: item.text },
    provider,
    { cache: opts.cache, thresholds: thresholds('recall') },
  );
  return { readings: analysed.readings, firedAxes: routed.firedAxes };
}

/**
 * The prediction under a threshold pair is the §7 multi-yes test itself: two or
 * more readings on the SAME interpretation axis both HIGH.
 */
function predict(raw, t) {
  if (!raw || !raw.readings.length) return 'clear';
  const scored = scoreClause({ text: '', id: 'g' }, raw.readings, { firedAxes: raw.firedAxes, thresholds: t });
  if (scored.regime === 'ambiguous') return 'ambiguous';
  if (scored.regime === 'uncertain') return 'uncertain';
  return 'clear';
}

function evaluate(items, evaluated, t) {
  let tp = 0, fp = 0, fn = 0, tn = 0, inconclusive = 0;
  for (const item of items) {
    const pred = predict(evaluated.get(item), t);
    const isAmbiguous = item.label === 'ambiguous';
    if (pred === 'uncertain') {
      inconclusive++;
      // The dead zone is a review queue, not a verdict. An uncertain clause is
      // NOT counted as a catch: counting it would launder the dead zone into recall.
      if (isAmbiguous) fn++; else tn++;
      continue;
    }
    if (pred === 'ambiguous' && isAmbiguous) tp++;
    else if (pred === 'ambiguous') fp++;
    else if (isAmbiguous) fn++;
    else tn++;
  }
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const beta2 = 4;
  const fbeta2 = precision + recall
    ? ((1 + beta2) * precision * recall) / (beta2 * precision + recall)
    : 0;
  return {
    tp, fp, fn, tn, inconclusive,
    recall: round3(recall),
    precision: round3(precision),
    fbeta2: round3(fbeta2),
    accuracy: round3((tp + tn) / Math.max(1, items.length)),
  };
}

/** Stratified halving with a seeded shuffle, so a run is reproducible. */
function split(items, seed) {
  const byLabel = new Map();
  for (const item of items) {
    if (!byLabel.has(item.label)) byLabel.set(item.label, []);
    byLabel.get(item.label).push(item);
  }
  const fit = [];
  const held = [];
  for (const group of byLabel.values()) {
    const shuffled = shuffle(group, seed);
    shuffled.forEach((item, i) => (i % 2 === 0 ? fit : held).push(item));
  }
  return { fit, held };
}

function shuffle(arr, seed) {
  const out = [...arr];
  let s = seed || 1;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function formatCalibration(r) {
  const L = [];
  L.push('Calibration — ' + r.n + ' items (' + r.fitN + ' fit / ' + r.heldN + ' held out), model ' + r.model);
  L.push('');
  L.push('Fitted on the fit half:  HIGH ' + r.fitted.HIGH + '  LOW ' + r.fitted.LOW);
  L.push('  fit half    recall ' + pct(r.fitHalf.recall) + '  precision ' + pct(r.fitHalf.precision) + '  (tp ' + r.fitHalf.tp + ' fp ' + r.fitHalf.fp + ' fn ' + r.fitHalf.fn + ' tn ' + r.fitHalf.tn + ')');
  L.push('');
  L.push('HELD-OUT HALF (the only honest number):');
  L.push('  recall      ' + pct(r.heldHalf.recall) + '   <- headline: a missed reading is a missed ambiguity');
  L.push('  precision   ' + pct(r.heldHalf.precision));
  L.push('  dead zone   ' + r.heldHalf.inconclusive + ' item(s) sent to review, counted as misses');
  L.push('');
  L.push('Shipped default (HIGH ' + r.shippedDefault.thresholds.HIGH + ' / LOW ' + r.shippedDefault.thresholds.LOW + ') on the same held-out half:');
  L.push('  recall ' + pct(r.shippedDefault.heldHalf.recall) + '  precision ' + pct(r.shippedDefault.heldHalf.precision));
  L.push('');
  for (const item of r.perItem) {
    const ok = item.predicted === item.label ? '  ' : '!!';
    L.push(ok + ' ' + pad(item.label, 11) + '-> ' + pad(item.predicted, 12) + item.text);
  }
  L.push('');
  L.push('CAVEAT: ' + r.caveat);
  if (r.synthetic) L.push('WARNING: fitted on the offline stand-in judge. Meaningless as calibration.');
  return L.join('\n');
}

function pct(x) {
  return (x * 100).toFixed(0) + '%';
}

function pad(s, n) {
  return String(s).length >= n ? String(s) + ' ' : String(s) + ' '.repeat(n - String(s).length);
}

function round2(x) { return Math.round(x * 100) / 100; }
function round3(x) { return Math.round(x * 1000) / 1000; }
