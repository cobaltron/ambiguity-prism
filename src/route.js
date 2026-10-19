// §3/§4 — axis routing. Code decides which readings apply; Jev only judges them.
// An axis fires only when its trigger token is present, which keeps the battery
// small (§12: a clause plus ~6 readings is ~220 tokens).

import { INTERPRETATION_AXES, VAGUENESS } from './axes.js';
import { lintReading } from './lint.js';
import { loadProposals } from './proposals.js';

const MAX_READINGS_PER_CLAUSE = 12;

/**
 * Build the reading battery for one clause.
 * @param {string} clause
 * @param {{dismissed?: string[], proposals?: object, freeText?: boolean}} [opts]
 * @returns {{readings: Reading[], firedAxes: object[], lint: object[], skipped: object[]}}
 */
export function route(clause, opts = {}) {
  const dismissed = new Set(opts.dismissed ?? []);
  const readings = [];
  const firedAxes = [];
  const lint = [];
  const skipped = [];

  for (const axis of INTERPRETATION_AXES) {
    if (dismissed.has(axis.id)) {
      skipped.push({ axis: axis.id, why: 'dismissed' });
      continue;
    }
    let hit = null;
    try {
      hit = axis.trigger(clause);
    } catch (err) {
      skipped.push({ axis: axis.id, why: 'trigger threw: ' + err.message });
      continue;
    }
    if (!hit) continue;

    const produced = axis.readings(hit).filter((r) => {
      const problems = lintReading(r);
      if (problems.length) {
        // A reading that breaks the §13 discipline is dropped, not sent: an
        // indirect or negated question is exactly what Jev answers badly.
        lint.push({ reading: r.id, label: r.label, problems });
        return false;
      }
      return true;
    });

    if (produced.length < 2) {
      // A single surviving reading cannot show a fork, so it carries no signal.
      skipped.push({ axis: axis.id, why: 'fewer than two readings survived' });
      continue;
    }

    firedAxes.push({ id: axis.id, label: axis.label, trigger: hit.match, lane: 'interpretation' });
    readings.push(...produced);
  }

  // Vagueness lane — evaluated alongside, never mixed into the fork test.
  if (!dismissed.has(VAGUENESS.id)) {
    const hit = VAGUENESS.trigger(clause);
    if (hit) {
      firedAxes.push({ id: VAGUENESS.id, label: VAGUENESS.label, trigger: hit.match, lane: 'vagueness' });
      readings.push(...VAGUENESS.readings(hit));
    }
  }

  // §5 source 2: reviewed offline proposals for free-text clauses. Never generated
  // at runtime — read from a stored artifact and linted like anything else.
  const proposed = loadProposals(opts.proposals, clause);
  if (proposed.length >= 2 && !dismissed.has('proposed')) {
    const clean = proposed.filter((r) => {
      const problems = lintReading(r);
      if (problems.length) lint.push({ reading: r.id, label: r.label, problems });
      return problems.length === 0;
    });
    if (clean.length >= 2) {
      firedAxes.push({ id: 'proposed', label: 'Reviewed proposal', trigger: 'offline artifact', lane: 'interpretation' });
      readings.push(...clean);
    }
  }

  return {
    readings: readings.slice(0, MAX_READINGS_PER_CLAUSE),
    firedAxes,
    lint,
    skipped,
    truncated: readings.length > MAX_READINGS_PER_CLAUSE,
  };
}
