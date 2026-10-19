// §9 — the report render. Bars, never a quoted probability (§7 trust boundary).

import { quote } from './segment.js';
import { REGIME } from './score.js';

const DOT = {
  [REGIME.ERROR]: '❗',
  [REGIME.AMBIGUOUS]: '\u{1F534}',
  [REGIME.UNDERSPECIFIED]: '\u{1F7E1}',
  [REGIME.UNCERTAIN]: '⚪',
  [REGIME.UNAMBIGUOUS]: '\u{1F7E2}',
  [REGIME.CLEAN]: '\u{1F7E2}',
};

const BAR_WIDTH = 8;

/** Eight-cell bar. A bar, never a percentage. */
export function bar(noul, width = BAR_WIDTH) {
  const filled = Math.round(clamp01(noul) * width);
  return '▓'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

export function renderReport(analysis, opts = {}) {
  const lines = [];
  const name = opts.name ?? 'input';
  const s = analysis.summary;

  lines.push(
    [
      name,
      s.clauses + ' clause' + (s.clauses === 1 ? '' : 's'),
      s.ambiguous + ' ambiguous',
      s.underspecified + ' underspecified',
      s.uncertain + ' uncertain',
      s.clear + ' clear',
      ...(s.failed ? [s.failed + ' FAILED'] : []),
    ].join(' · '),
  );
  lines.push('');

  const order = { [REGIME.ERROR]: -1, [REGIME.AMBIGUOUS]: 0, [REGIME.UNDERSPECIFIED]: 1, [REGIME.UNCERTAIN]: 2 };
  const sorted = [...analysis.clauses].sort((a, b) => {
    const oa = order[a.regime] ?? 3;
    const ob = order[b.regime] ?? 3;
    if (oa !== ob) return oa - ob;
    return (b.severity ?? 0) - (a.severity ?? 0);
  });

  for (const c of sorted) {
    if (opts.only && c.regime !== opts.only) continue;
    if (!opts.verbose && (c.regime === REGIME.UNAMBIGUOUS || c.regime === REGIME.CLEAN)) {
      lines.push(headline(c) + '   clear');
      continue;
    }
    lines.push(headline(c) + tail(c));
    lines.push(...detail(c));
    lines.push('');
  }

  lines.push('— ' + analysis.disclosure);
  lines.push(
    '  model ' + analysis.model +
    ' · stance ' + analysis.stance +
    ' · ' + analysis.cost.readings + ' readings' +
    (analysis.cost.cached ? ' (' + analysis.cost.cached + ' clauses cached)' : '') +
    ' · est $' + analysis.cost.usd.toFixed(6),
  );
  if (analysis.synthetic) {
    lines.push('  WARNING: values came from the offline stand-in judge, not from Jev. Not evidence of anything.');
  }
  for (const e of analysis.errors ?? []) lines.push('  error on ' + e.clause + ': ' + e.error);

  return lines.join('\n');
}

function headline(c) {
  const loc = c.section ? '§' + c.section : 'L' + c.line;
  return (DOT[c.regime] ?? '⚪') + '  ' + pad(loc, 7) + ' "' + quote(c.clause) + '"';
}

function tail(c) {
  if (c.regime === REGIME.ERROR) return '   NOT MEASURED';
  if (c.regime === REGIME.AMBIGUOUS) return '   severity ' + c.severity.toFixed(2);
  if (c.regime === REGIME.UNDERSPECIFIED) return '   underspecified';
  if (c.regime === REGIME.UNCERTAIN) return '   needs review';
  return '';
}

function detail(c) {
  const out = [];

  // A failed request is reported as a failure, never as a finding about the text.
  if (c.regime === REGIME.ERROR) {
    out.push('      request failed: ' + c.error);
    out.push('      nothing was evaluated, so nothing is claimed about this clause');
    return out;
  }

  const primary = c.axes.find((a) => a.id === c.primaryAxis);

  if (primary) {
    for (const r of primary.top) {
      const mark = r.verdict === 'high' ? '▸' : r.verdict === 'inconclusive' ? '▹' : ' ';
      out.push('      ' + mark + ' ' + pad(r.label, 42) + ' ' + bar(r.noul) + ' ' + r.noul.toFixed(2));
    }
  }

  for (const id of c.secondary ?? []) {
    const axis = c.axes.find((a) => a.id === id);
    if (!axis) continue;
    const [a, b] = axis.top;
    if (!a || !b) continue;
    out.push(
      '      secondary: ' + axis.label.toLowerCase() + ' — ' +
      a.label + ' (' + a.noul.toFixed(2) + ') vs ' + b.label + ' (' + b.noul.toFixed(2) + ')',
    );
  }

  if (c.regime === REGIME.UNCERTAIN) {
    out.push('      readings sit in the dead zone (' + c.thresholds.LOW + '–' + c.thresholds.HIGH + '); not passed, not flagged');
  }
  if (c.noAxisFired) {
    out.push('      no axis fired: no reading was asked, so nothing is claimed');
  }
  for (const l of c.lint ?? []) {
    out.push('      lint: dropped "' + l.label + '" — ' + l.problems.join('; '));
  }

  if (c.regime === REGIME.AMBIGUOUS) {
    out.push('      [ accept ] [ rewrite ] [ dismiss axis: ' + c.primaryAxis + ' ]');
  } else if (c.regime === REGIME.UNDERSPECIFIED) {
    out.push('      [ accept ] [ rewrite ] [ dismiss ]');
  }
  return out;
}

/**
 * §9 rewrite view: the competing readings side by side, naming the fork the author
 * must separate. Code-side only; the model is never tuned against the user.
 */
export function renderRewrite(c) {
  const axis = c.axes.find((a) => a.id === c.primaryAxis);
  if (!axis) return 'Nothing to separate on this clause.';
  const lit = axis.top.filter((r) => r.verdict === 'high');
  const lines = [
    'Clause: ' + c.clause,
    '',
    'Fork on: ' + axis.label + (axis.trigger ? '  (triggered by "' + axis.trigger + '")' : ''),
    '',
  ];
  (lit.length >= 2 ? lit : axis.top.slice(0, 2)).forEach((r, i) => {
    lines.push('  Reading ' + (i + 1) + ': ' + r.label + '   ' + bar(r.noul) + ' ' + r.noul.toFixed(2));
    lines.push('    asked: ' + r.instructions);
    lines.push('');
  });
  lines.push('Both readings are supported by the words as written. Rewrite so that exactly');
  lines.push('one of them survives; the prism will show the other beam go dark.');
  return lines.join('\n');
}

function pad(s, n) {
  return String(s).length >= n ? String(s) : String(s) + ' '.repeat(n - String(s).length);
}

function clamp01(x) {
  return Math.min(1, Math.max(0, Number(x) || 0));
}
