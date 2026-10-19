#!/usr/bin/env node
// Phase-1 CLI: the mechanism, headless.
//
//   prism analyze <file|->   [--json] [--verbose] [--provider auto|jev|heuristic]
//                            [--stance recall|precision] [--only ambiguous]
//                            [--requirements-only] [--no-cache] [--proposals f.json]
//   prism clause "<text>"    same, for one sentence
//   prism rewrite <file> <id>  the §9 side-by-side rewrite view
//   prism probe [file]       forked vs clean pairs; the phase-1 exit check
//   prism calibrate <gold>   fit HIGH/LOW on one half, score the other (§10)
//   prism lint               lint every reading the axis table can produce (§13)
//   prism serve              start the local proxy + prism UI

import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { loadEnv } from '../src/env.js';
import { analyzeDocument, analyzeClause } from '../src/analyze.js';
import { createProvider } from '../src/provider/index.js';
import { renderReport, renderRewrite, bar } from '../src/report.js';
import { createFileCache, createNullCache } from '../src/cache.js';
import { thresholds, STANCES } from '../src/score.js';
import { route } from '../src/route.js';
import { lintBattery } from '../src/lint.js';
import { segment } from '../src/segment.js';
import { AXES_BY_ID } from '../src/axes.js';
import { validateProposals } from '../src/proposals.js';
import { calibrate, formatCalibration } from '../src/calibrate.js';
import { createReviewStore } from '../src/review.js';

// .env first: everything below reads process.env. A real environment variable
// still wins over the file.
const env = loadEnv();

const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = parseFlags(argv.slice(1));
const positional = flags._;

main().catch((err) => {
  console.error('prism: ' + (err?.message ?? err));
  if (/TYPESAFE_API_KEY/.test(err?.message ?? '')) {
    console.error('');
    console.error(env.loaded
      ? 'Loaded .env from ' + env.loaded + ', but it did not define TYPESAFE_API_KEY.'
      : 'No .env file found from ' + process.cwd() + ' upward.');
  }
  process.exitCode = 1;
});

async function main() {
  switch (cmd) {
    case 'analyze': return cmdAnalyze();
    case 'clause': return cmdClause();
    case 'rewrite': return cmdRewrite();
    case 'probe': return cmdProbe();
    case 'calibrate': return cmdCalibrate();
    case 'accept': return await cmdAccept();
    case 'dismiss': return cmdDismiss();
    case 'review': return cmdReview();
    case 'lint': return cmdLint();
    case 'serve': return cmdServe();
    case undefined:
    case '-h':
    case '--help': return usage();
    default:
      console.error('prism: unknown command "' + cmd + '"\n');
      usage();
      process.exitCode = 1;
  }
}

function usage() {
  console.log(readFileSync(new URL('./usage.txt', import.meta.url), 'utf8'));
}

function common() {
  const provider = createProvider(flags.provider ?? 'auto');
  const cache = flags['no-cache'] ? createNullCache() : createFileCache(flags['cache-dir'] ?? '.cache');
  const t = thresholds(flags.stance ?? 'recall', numericOverrides());
  let proposals = null;
  if (flags.proposals) {
    proposals = JSON.parse(readFileSync(flags.proposals, 'utf8'));
    const problems = validateProposals(proposals);
    for (const p of problems) console.error('proposals: ' + p);
  }
  const review = createReviewStore(flags['review-dir'] ?? '.prism');
  return { provider, cache, thresholds: t, proposals, review };
}

function numericOverrides() {
  const o = {};
  if (flags.high) o.HIGH = Number(flags.high);
  if (flags.low) o.LOW = Number(flags.low);
  if (flags['exit-high']) o.EXIT_HIGH = Number(flags['exit-high']);
  return Object.keys(o).length ? o : undefined;
}

async function cmdAnalyze() {
  const target = positional[0];
  if (!target) throw new Error('analyze needs a file (or - for stdin)');
  const doc = target === '-' ? readStdin() : readFileSync(target, 'utf8');
  const { provider, cache, thresholds: t, proposals, review } = common();

  const analysis = await analyzeDocument(doc, provider, {
    cache,
    thresholds: t,
    proposals,
    review,
    dismissed: review.dismissedMap(),
    requirementsOnly: Boolean(flags['requirements-only']),
    concurrency: flags.concurrency ? Number(flags.concurrency) : undefined,
  });
  cache.flush?.();

  if (flags.json) {
    console.log(JSON.stringify(analysis, null, 2));
  } else {
    console.log(renderReport(analysis, {
      name: target === '-' ? 'stdin' : basename(target),
      verbose: Boolean(flags.verbose),
      only: flags.only,
    }));
  }
  // A run with failed requests is not a clean run, whatever the findings were.
  if (analysis.errors.length) process.exitCode = 1;
  if (flags['fail-on-ambiguous'] && analysis.summary.ambiguous > 0) process.exitCode = 2;
}

async function cmdClause() {
  const text = positional.join(' ');
  if (!text) throw new Error('clause needs a sentence');
  const { provider, cache, thresholds: t, proposals } = common();
  const analysis = await analyzeDocument(text, provider, { cache, thresholds: t, proposals, single: true });
  cache.flush?.();
  if (flags.json) console.log(JSON.stringify(analysis.clauses[0] ?? null, null, 2));
  else console.log(renderReport(analysis, { name: 'clause', verbose: true }));
  if (analysis.errors.length) process.exitCode = 1;
}

async function cmdRewrite() {
  const [target, id] = positional;
  if (!target) throw new Error('rewrite needs a file and a clause id (e.g. c2)');
  const doc = readFileSync(target, 'utf8');
  const { provider, cache, thresholds: t } = common();
  const analysis = await analyzeDocument(doc, provider, { cache, thresholds: t });
  cache.flush?.();
  const picked = id
    ? analysis.clauses.find((c) => c.id === id || c.section === id)
    : analysis.clauses.filter((c) => c.regime === 'ambiguous').sort((a, b) => b.severity - a.severity)[0];
  if (!picked) throw new Error('no such clause, and nothing ambiguous to rewrite');
  console.log(renderRewrite(picked));
}

/**
 * Phase-1 exit criterion: on hand-written forked vs clean clauses, does the
 * multi-yes signal separate them?
 */
async function cmdProbe() {
  const file = positional[0] ?? 'fixtures/clauses.json';
  if (!existsSync(file)) throw new Error('no probe file at ' + file);
  const { pairs } = JSON.parse(readFileSync(file, 'utf8'));
  const { provider, cache, thresholds: t } = common();

  console.log('stance ' + t.stance + '  HIGH ' + t.HIGH + '  LOW ' + t.LOW + '  model ' + provider.model);
  console.log('');
  let pass = 0;
  for (const pair of pairs) {
    const forked = await analyzeClause({ id: 'f', text: pair.forked }, provider, { cache, thresholds: t });
    const clean = await analyzeClause({ id: 'c', text: pair.clean }, provider, { cache, thresholds: t });
    const fAxis = forked.axes.find((a) => a.id === pair.axis);
    const cAxis = clean.axes.find((a) => a.id === pair.axis);

    // The claim under test: the suspect clause does NOT resolve on its axis, and
    // the rewritten one does. `expect: fork` additionally demands the multi-yes
    // signature (two readings HIGH at once); `expect: deadzone` accepts an
    // unresolved axis that only lights one reading.
    const forkedUnresolved = Boolean(fAxis) && !fAxis.resolved;
    const cleanResolved = !cAxis || cAxis.resolved;
    const signatureOk = pair.expect === 'deadzone' ? forkedUnresolved : Boolean(fAxis?.forked);
    const ok = forkedUnresolved && cleanResolved && signatureOk;
    if (ok) pass++;
    console.log((ok ? 'PASS' : 'FAIL') + '  axis ' + pair.axis + '  (expect ' + (pair.expect ?? 'fork') + ')');
    console.log('   forked: ' + describeAxis(fAxis) + '   ' + pair.forked);
    console.log('   clean : ' + describeAxis(cAxis) + '   ' + pair.clean);
    console.log('');
  }
  cache.flush?.();
  console.log(pass + '/' + pairs.length + ' axes separate forked from clean.');
  if (provider.synthetic) {
    console.log('WARNING: offline stand-in judge. This checks the mechanism and the');
    console.log('thresholds plumbing, NOT whether Jev separates these clauses.');
  }
  if (pass < pairs.length) process.exitCode = 2;
}

function describeAxis(axis) {
  if (!axis) return 'did not fire'.padEnd(8) + '          ';
  const vals = axis.top.map((r) => r.noul.toFixed(2)).join('/');
  const state = axis.forked ? 'FORKED' : axis.resolved ? 'single' : 'DEADZN';
  return state + ' ' + bar(axis.top[0].noul, 5) + ' ' + vals.padEnd(10);
}

async function cmdCalibrate() {
  const file = positional[0] ?? 'fixtures/goldset.json';
  const gold = JSON.parse(readFileSync(file, 'utf8'));
  const { provider, cache } = common();
  const result = await calibrate(gold, provider, {
    cache,
    seed: flags.seed ? Number(flags.seed) : 1,
    allowSynthetic: Boolean(flags['allow-synthetic']),
  });
  cache.flush?.();
  if (flags.json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatCalibration(result));
}

/** §9 "accept": record a clause as reviewed, keyed by its text. */
async function cmdAccept() {
  const [target, id] = positional;
  if (!target || !id) throw new Error('accept needs a file and a clause id (e.g. c3 or 4.2)');
  const doc = readFileSync(target, 'utf8');
  const clause = segment(doc).find((c) => c.id === id || c.section === id);
  if (!clause) throw new Error('no clause "' + id + '" in ' + target);
  const { review } = common();
  review.accept(clause.text, flags.note ?? null);
  console.log('accepted: ' + clause.text);
  console.log('Stored in ' + review.path + '. Editing the clause revokes this automatically.');
}

/** §9 "dismiss axis": suppress one templated axis for a clause or a document. */
function cmdDismiss() {
  const [axis, scope] = positional;
  if (!axis) throw new Error('dismiss needs an axis id (e.g. boundary), optionally a clause text or "*"');
  if (!AXES_BY_ID.has(axis)) {
    throw new Error('unknown axis "' + axis + '"; known: ' + [...AXES_BY_ID.keys()].join(', '));
  }
  const { review } = common();
  if (flags.undo) {
    review.undismiss(axis, scope ?? '*');
    console.log('restored axis ' + axis + ' for ' + (scope ?? 'the whole document'));
    return;
  }
  review.dismiss(axis, scope ?? '*');
  console.log('dismissed axis ' + axis + ' for ' + (scope ?? 'the whole document'));
  console.log('Stored in ' + review.path + '. This suppresses a reading set; it does not retune anything.');
}

function cmdReview() {
  const { review } = common();
  const s = review.summary();
  console.log('review state: ' + review.path);
  console.log('  accepted clauses   ' + s.accepted);
  console.log('  dismissed globally ' + (s.dismissedGlobally.join(', ') || 'none'));
  console.log('  clause-scoped sets ' + s.scopes);
}

function cmdLint() {
  const doc = positional[0] && existsSync(positional[0])
    ? readFileSync(positional[0], 'utf8')
    : readFileSync('fixtures/requirements.md', 'utf8');
  let total = 0;
  let bad = 0;
  for (const clause of segment(doc)) {
    const routed = route(clause.text);
    total += routed.readings.length;
    const problems = lintBattery(routed.readings);
    for (const p of problems) {
      bad++;
      console.log('FAIL ' + clause.id + ' ' + p.id + ': ' + p.problems.join('; '));
    }
    for (const dropped of routed.lint) {
      bad++;
      console.log('DROPPED ' + clause.id + ' ' + dropped.reading + ': ' + dropped.problems.join('; '));
    }
  }
  console.log(total + ' readings produced, ' + bad + ' flagged.');
  if (bad) process.exitCode = 2;
}

async function cmdServe() {
  process.env.PRISM_PORT = flags.port ?? process.env.PRISM_PORT ?? '8787';
  await import('../server/proxy.js');
}

function parseFlags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out[k] = v;
      else if (args[i + 1] && !args[i + 1].startsWith('--')) out[k] = args[++i];
      else out[k] = true;
    } else {
      out._.push(a);
    }
  }
  if (out.stance && !STANCES[out.stance]) {
    throw new Error('unknown stance "' + out.stance + '"; use recall or precision');
  }
  return out;
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    throw new Error('could not read stdin');
  }
}
