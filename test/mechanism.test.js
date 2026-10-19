import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { segment, splitSentences } from '../src/segment.js';
import { route } from '../src/route.js';
import { lintReading } from '../src/lint.js';
import { AXES, VAGUENESS } from '../src/axes.js';
import {
  scoreClause, severityOf, normalisedEntropy, thresholds, verdictFor, summarise,
} from '../src/score.js';
import { cacheKey, readingSetHash, createMemoryCache } from '../src/cache.js';
import { createHeuristicProvider } from '../src/provider/heuristic.js';
import { createJevProvider, readNouls } from '../src/provider/jev.js';
import { createProvider } from '../src/provider/index.js';
import { loadEnv, fingerprint } from '../src/env.js';
import { analyzeClause, analyzeDocument } from '../src/analyze.js';
import { loadProposals, validateProposals } from '../src/proposals.js';

const WORKED = 'The service should retry failed requests up to three times before returning an error.';
const T = thresholds('recall');

describe('segmentation (§3, code-side only)', () => {
  test('keeps section labels and flags requirement lines', () => {
    const [a, b] = segment('4.2 The service should retry up to three times.\n\n7.1 It is fine.');
    assert.equal(a.section, '4.2');
    assert.equal(a.isRequirement, true);
    assert.equal(b.section, '7.1');
  });

  test('does not split on abbreviations, decimals or versions', () => {
    assert.equal(splitSentences('Use jev-1.13.0, e.g. not latest.').length, 1);
    assert.equal(splitSentences('Wait 1.5 seconds. Then retry.').length, 2);
  });

  test('drops fragments shorter than three words', () => {
    assert.equal(segment('# Heading\n\nOK.\n\nThe client must retry the request.').length, 1);
  });
});

describe('axis routing (§4)', () => {
  test('an axis fires only when its trigger token is present', () => {
    const withNumber = route(WORKED).firedAxes.map((a) => a.id);
    assert.ok(withNumber.includes('boundary'));
    const without = route('The client must validate the signature.').firedAxes.map((a) => a.id);
    assert.ok(!without.includes('boundary'));
  });

  test('boundary readings name both countings explicitly', () => {
    const readings = route(WORKED).readings.filter((r) => r.axis === 'boundary');
    assert.equal(readings.length, 2);
    assert.match(readings[0].instructions, /ADDITION/);
    assert.match(readings[1].instructions, /TOTAL/);
  });

  test('vagueness is discharged by a measurable threshold', () => {
    assert.ok(VAGUENESS.trigger('The system shall respond quickly.'));
    assert.equal(VAGUENESS.trigger('The system shall respond quickly, within 200 ms.'), null);
  });

  test('vagueness rides a separate lane, never the fork test', () => {
    const fired = route('The system shall respond quickly to user actions.').firedAxes;
    assert.equal(fired.find((a) => a.id === 'vagueness').lane, 'vagueness');
  });

  test('reference needs two visible antecedents and ignores a naming description', () => {
    const ref = AXES.find((a) => a.id === 'reference');
    assert.ok(ref.trigger('The gateway shall forward the request to the primary server, and the worker must retry it.'));
    // Only one candidate noun before the pronoun.
    assert.equal(ref.trigger('The resource must expose it.'), null);
    // "the request" names its single antecedent: that is the fix, not a fork.
    assert.equal(
      ref.trigger('The gateway shall forward the request to the primary server, and the worker must retry the request.'),
      null,
    );
  });

  test('attachment does not read verbs or function words as nouns', () => {
    const attach = AXES.find((a) => a.id === 'attachment');
    assert.equal(attach.trigger('The API shall return HTTP status 404 when the requested resource does not exist.'), null);
    assert.equal(attach.trigger('The service must emit a metric for every retry.'), null);
    const hit = attach.trigger('The scheduler must process the queued request log.');
    assert.deepEqual([hit.modifier, hit.near, hit.far], ['queued', 'request', 'log']);
  });

  test('an axis that yields fewer than two readings does not fire', () => {
    for (const axis of route(WORKED).firedAxes) {
      if (axis.lane !== 'interpretation') continue;
      const count = route(WORKED).readings.filter((r) => r.axis === axis.id).length;
      assert.ok(count >= 2, axis.id + ' fired with ' + count + ' reading(s)');
    }
  });
});

describe('reading lint (§13)', () => {
  test('every templated reading the axis table can produce is sendable', () => {
    const corpus = [
      WORKED,
      'The gateway must compress or encrypt the response body.',
      'The worker shall archive all records that exceed the retention window.',
      'The scheduler must process the queued request log before the window opens.',
      'The gateway shall forward the request to the primary server, and the worker must retry it.',
      'The system shall respond quickly to user actions.',
      'The job may be restarted between 2 and 5 times.',
    ];
    for (const clause of corpus) {
      const routed = route(clause);
      assert.deepEqual(routed.lint, [], 'lint dropped readings for: ' + clause);
      for (const r of routed.readings) {
        assert.deepEqual(lintReading(r), [], r.id + ' failed lint on: ' + clause);
      }
    }
  });

  test('rejects negation, bundling and indirection', () => {
    assert.ok(lintReading({ instructions: 'Does this not require three retries?' }).length);
    assert.ok(lintReading({ instructions: 'Is it mandatory and also optional?' }).length);
    assert.ok(lintReading({ instructions: 'Would this imply three retries?' }).length);
    assert.ok(lintReading({ instructions: 'Is it A? Is it B?' }).length);
  });

  test('an exempt reading may state an absence, because that IS the defect', () => {
    const vague = VAGUENESS.readings({ term: 'quickly' })[0];
    assert.ok(vague.lintExempt);
    assert.deepEqual(lintReading(vague), []);
  });
});

describe('scoring (§7)', () => {
  test('three outcomes with an explicit inconclusive band', () => {
    assert.equal(verdictFor(0.9, T), 'high');
    assert.equal(verdictFor(0.5, T), 'inconclusive');
    assert.equal(verdictFor(0.1, T), 'low');
  });

  test('severity reproduces the worked example to within 0.01', () => {
    assert.ok(Math.abs(severityOf([0.71, 0.66]) - 0.82) <= 0.01);
  });

  test('entropy is computed on raw values, not a normalised distribution', () => {
    // Doubling one reading changes the shape; a Choice distribution could not
    // express both-high at all, which is the point of using absolute Nouls.
    assert.ok(normalisedEntropy([0.71, 0.66]) > 0.99);
    assert.ok(normalisedEntropy([0.9, 0.05]) < 0.35);
  });

  test('two dim but evenly matched readings are not severe', () => {
    assert.ok(severityOf([0.2, 0.2]) < severityOf([0.7, 0.7]));
  });

  test('the multi-yes signature on one axis means ambiguous', () => {
    const r = scoreClause({ text: WORKED, id: 'c1' }, [
      { id: 'a', axis: 'boundary', label: 'extra', noul: 0.71 },
      { id: 'b', axis: 'boundary', label: 'total', noul: 0.66 },
    ], { firedAxes: [{ id: 'boundary', label: 'Boundary', lane: 'interpretation' }], thresholds: T });
    assert.equal(r.regime, 'ambiguous');
    assert.equal(r.primaryAxis, 'boundary');
    assert.ok(r.axes[0].forked);
  });

  test('one high and the rest low on every axis means unambiguous', () => {
    const r = scoreClause({ text: 'x', id: 'c' }, [
      { id: 'a', axis: 'obligation', label: 'mandatory', noul: 0.93 },
      { id: 'b', axis: 'obligation', label: 'optional', noul: 0.05 },
    ], { firedAxes: [{ id: 'obligation', label: 'Obligation', lane: 'interpretation' }], thresholds: T });
    assert.equal(r.regime, 'unambiguous');
  });

  test('dead-zone readings are never silently passed', () => {
    const r = scoreClause({ text: 'x', id: 'c' }, [
      { id: 'a', axis: 'obligation', label: 'mandatory', noul: 0.44 },
      { id: 'b', axis: 'obligation', label: 'optional', noul: 0.52 },
    ], { firedAxes: [{ id: 'obligation', label: 'Obligation', lane: 'interpretation' }], thresholds: T });
    assert.equal(r.regime, 'uncertain');
  });

  test('vagueness yields underspecified even when obligation is cleanly high', () => {
    // §9 clause 3: obligation is HIGH at 0.90. What makes it underspecified is the
    // absence of a fork, not the absence of a lit reading.
    const r = scoreClause({ text: 'x', id: 'c' }, [
      { id: 'm', axis: 'obligation', label: 'mandatory', noul: 0.90 },
      { id: 'o', axis: 'obligation', label: 'optional', noul: 0.08 },
      { id: 'v', axis: 'vagueness', label: 'no threshold', noul: 0.88 },
    ], {
      firedAxes: [
        { id: 'obligation', label: 'Obligation', lane: 'interpretation' },
        { id: 'vagueness', label: 'Vagueness', lane: 'vagueness' },
      ],
      thresholds: T,
    });
    assert.equal(r.regime, 'underspecified');
  });

  test('hysteresis: a lit beam survives between EXIT_HIGH and HIGH', () => {
    const readings = [{ id: 'a', axis: 'x', label: 'a', noul: 0.55 }];
    const fired = [{ id: 'x', label: 'X', lane: 'interpretation' }];
    const cold = scoreClause({ text: 't', id: 'c' }, readings, { firedAxes: fired, thresholds: T });
    const warm = scoreClause({ text: 't', id: 'c' }, readings, {
      firedAxes: fired, thresholds: T, previous: { lit: { a: true } },
    });
    assert.equal(cold.axes[0].readings[0].lit, false, '0.55 must not light from cold');
    assert.equal(warm.axes[0].readings[0].lit, true, '0.55 must stay lit once lit');
  });

  test('a beam does extinguish below EXIT_HIGH', () => {
    const r = scoreClause({ text: 't', id: 'c' }, [{ id: 'a', axis: 'x', label: 'a', noul: 0.40 }], {
      firedAxes: [{ id: 'x', label: 'X', lane: 'interpretation' }], thresholds: T, previous: { lit: { a: true } },
    });
    assert.equal(r.axes[0].readings[0].lit, false);
  });

  test('the trust boundary travels in the payload', () => {
    const r = scoreClause({ text: 'x', id: 'c' }, [], { firedAxes: [], thresholds: T });
    assert.match(r.trust, /not.*probabilit/i);
  });

  test('the precision stance flags strictly less than the recall stance', () => {
    const readings = [
      { id: 'a', axis: 'b', label: 'a', noul: 0.66 },
      { id: 'b', axis: 'b', label: 'b', noul: 0.63 },
    ];
    const fired = [{ id: 'b', label: 'B', lane: 'interpretation' }];
    assert.equal(scoreClause({ text: 'x', id: 'c' }, readings, { firedAxes: fired, thresholds: thresholds('recall') }).regime, 'ambiguous');
    assert.notEqual(scoreClause({ text: 'x', id: 'c' }, readings, { firedAxes: fired, thresholds: thresholds('precision') }).regime, 'ambiguous');
  });

  test('summarise counts each regime once', () => {
    const s = summarise([{ regime: 'ambiguous' }, { regime: 'underspecified' }, { regime: 'uncertain' }, { regime: 'unambiguous' }]);
    assert.deepEqual(s, { clauses: 4, ambiguous: 1, underspecified: 1, uncertain: 1, clear: 1, failed: 0 });
  });

  test('a failed request counts as failed, never as a verdict on the text', () => {
    const s = summarise([{ regime: 'error' }, { regime: 'ambiguous' }]);
    assert.equal(s.failed, 1);
    assert.equal(s.uncertain, 0, 'a failure must not be laundered into the review queue');
    assert.equal(s.clear, 0, 'nor into the clean pile');
  });
});

describe('cache (§12)', () => {
  test('the key covers model, clause and reading set', () => {
    const readings = route(WORKED).readings;
    const base = cacheKey('jev-1.13.0', WORKED, readings);
    assert.notEqual(base, cacheKey('jev-1.14.0', WORKED, readings), 'model bump must miss');
    assert.notEqual(base, cacheKey('jev-1.13.0', WORKED + ' Really.', readings), 'clause edit must miss');
    assert.notEqual(
      base,
      cacheKey('jev-1.13.0', WORKED, [...readings, { id: 'z', instructions: 'Does it hold?' }]),
      'reading-set change must miss',
    );
    assert.equal(base, cacheKey('jev-1.13.0', WORKED, readings), 'same inputs must hit');
  });

  test('reading-set hash is order independent', () => {
    const r = route(WORKED).readings;
    assert.equal(readingSetHash(r), readingSetHash([...r].reverse()));
  });

  test('a cached clause costs nothing on re-run', async () => {
    const cache = createMemoryCache();
    const provider = createHeuristicProvider();
    const first = await analyzeClause({ id: 'c1', text: WORKED }, provider, { cache });
    const second = await analyzeClause({ id: 'c1', text: WORKED }, provider, { cache });
    assert.equal(first.cost.cached, false);
    assert.equal(second.cost.cached, true);
    assert.equal(second.cost.estTokens, 0);
    assert.equal(cache.stats.hits, 1);
  });
});

describe('provider contract (§6)', () => {
  test('refuses an unpinned model', () => {
    assert.throws(() => createJevProvider({ model: 'jev-latest', apiKey: 'k' }), /jev-latest/);
  });

  test('there is no fallback: no key is a hard failure', () => {
    const saved = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      // Both 'auto' and 'jev' must refuse rather than quietly substituting values.
      assert.throws(() => createProvider('auto'), /TYPESAFE_API_KEY is not set/);
      assert.throws(() => createProvider('jev'), /TYPESAFE_API_KEY is not set/);
      // The test double stays reachable, but only when asked for by name.
      assert.equal(createProvider('heuristic').name, 'heuristic');
    } finally {
      if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
    }
  });

  test('auto selects jev when a key is present', () => {
    const saved = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = 'test-key';
    try {
      const p = createProvider('auto');
      assert.equal(p.name, 'jev');
      assert.equal(p.model, 'jev-1.13.0');
      assert.equal(p.synthetic, undefined);
    } finally {
      if (saved === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = saved;
    }
  });

  test('posts the documented endpoint, header and request shape', async () => {
    const seen = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      seen.push({ url, init, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        model: 'jev-1.13.0',
        answers: { a: { type: 'noul', noul: 0.7 }, b: { type: 'noul', noul: 0.6 } },
        usage: { input_tokens: 296, output_tokens: 20 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      const provider = createJevProvider({ apiKey: 'test-key' });
      const out = await provider.evaluate('A clause.', [
        { id: 'a', instructions: 'Does A hold?' },
        { id: 'b', instructions: 'Does B hold?' },
      ]);
      const call = seen[0];
      assert.equal(call.url, 'https://api.typesafe.ai/v1/systemone');
      assert.equal(call.init.headers.authorization, 'Bearer test-key');
      assert.deepEqual(Object.keys(call.body.state), ['clause'], 'state must carry only the clause');
      assert.equal(call.body.model, 'jev-1.13.0');
      assert.deepEqual(Object.keys(call.body.questions), ['a', 'b']);
      assert.equal(call.body.questions.a.type, 'noul', 'question type must be "noul"');
      assert.deepEqual(out.nouls, { a: 0.7, b: 0.6 });
      assert.equal(out.usage.input_tokens, 296, 'real token usage must be surfaced');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('reads the real "answers" container, and the doc\'s "nouls" shape too', () => {
    // The published API nests under `answers`; the design doc's §6 snippet says
    // `nouls`. Both must work, or a correct response would be rejected.
    assert.deepEqual(readNouls({ answers: { a: { type: 'noul', noul: 0.42 } } }, ['a']), { a: 0.42 });
    assert.deepEqual(readNouls({ nouls: { a: { noul: 0.42 } } }, ['a']), { a: 0.42 });
  });

  test('a missing noul is an error, not a silent zero', () => {
    assert.throws(() => readNouls({ answers: { a: { noul: 0.5 } } }, ['a', 'b']), /missing nouls for: b/);
  });

  test('raw values are passed through unnormalised', () => {
    // 0.71 + 0.66 > 1. If anything normalised, this would not survive.
    const out = readNouls({ answers: { a: { noul: 0.71 }, b: { noul: 0.66 } } }, ['a', 'b']);
    assert.equal(out.a + out.b, 1.37);
  });

  test('401 and 422 are not retried; 429 is', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response('nope', { status: 401, statusText: 'Unauthorized' });
    };
    try {
      const provider = createJevProvider({ apiKey: 'bad-key', maxRetries: 3 });
      await assert.rejects(
        provider.evaluate('A clause.', [{ id: 'a', instructions: 'Does A hold?' }]),
        /401 Unauthorized.*revoked/s,
      );
      assert.equal(calls, 1, 'an unchanged bad request must not be resent');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('429 is retried with backoff and then succeeds', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls < 3) {
        return new Response('slow down', {
          status: 429, statusText: 'Too Many Requests', headers: { 'retry-after': '0' },
        });
      }
      return new Response(JSON.stringify({ answers: { a: { noul: 0.8 } } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    };
    try {
      const provider = createJevProvider({ apiKey: 'k', maxRetries: 3 });
      const out = await provider.evaluate('A clause.', [{ id: 'a', instructions: 'Does A hold?' }]);
      assert.equal(calls, 3);
      assert.deepEqual(out.nouls, { a: 0.8 });
    } finally {
      globalThis.fetch = original;
    }
  });

  test('529 provider-overloaded is retried too', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) return new Response('overloaded', { status: 529, statusText: 'Overloaded' });
      return new Response(JSON.stringify({ answers: { a: { noul: 0.3 } } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    };
    try {
      const provider = createJevProvider({ apiKey: 'k', maxRetries: 2 });
      const out = await provider.evaluate('A clause.', [{ id: 'a', instructions: 'Does A hold?' }]);
      assert.equal(calls, 2);
      assert.deepEqual(out.nouls, { a: 0.3 });
    } finally {
      globalThis.fetch = original;
    }
  });

  test('refuses both floating aliases', () => {
    for (const alias of ['jev-latest', 'jev-preview']) {
      assert.throws(() => createJevProvider({ model: alias, apiKey: 'k' }), /Refusing the alias/);
    }
  });

  test('the stand-in judge marks everything synthetic', async () => {
    const out = await createHeuristicProvider().evaluate(WORKED, route(WORKED).readings);
    assert.equal(out.synthetic, true);
  });
});

describe('offline proposals (§5)', () => {
  test('an unreviewed entry is ignored at runtime', () => {
    const artifact = { entries: [{ clause: WORKED, readings: [{ id: 'p1', instructions: 'Does it hold?' }, { id: 'p2', instructions: 'Does it apply?' }] }] };
    assert.deepEqual(loadProposals(artifact, WORKED), []);
    assert.ok(validateProposals(artifact).some((p) => /not reviewed/.test(p)));
  });

  test('a reviewed entry is loaded and still linted', () => {
    const artifact = {
      entries: [{
        clause: WORKED,
        reviewedBy: 'author',
        readings: [
          { id: 'p1', label: 'ok', instructions: 'Does the sentence require three attempts?' },
          { id: 'p2', label: 'bad', instructions: 'Does this not require three attempts?' },
        ],
      }],
    };
    assert.equal(loadProposals(artifact, WORKED).length, 2);
    const routed = route(WORKED, { proposals: artifact });
    assert.ok(routed.lint.some((l) => l.reading === 'p2'), 'the negated proposal must be dropped');
    assert.ok(!routed.readings.some((r) => r.id === 'p2'));
  });
});

describe('end to end', () => {
  test('the §9 worked clauses land in their documented regimes', async () => {
    const provider = createHeuristicProvider();
    const cases = [
      [WORKED, 'ambiguous'],
      ['The API shall return HTTP status 404 when the requested resource does not exist.', 'unambiguous'],
      ['The system shall respond quickly to user actions.', 'underspecified'],
    ];
    for (const [text, expected] of cases) {
      const r = await analyzeClause({ id: 'c', text }, provider, {});
      assert.equal(r.regime, expected, text);
    }
  });

  test('fixing the forked clause collapses it to one surviving reading', async () => {
    const provider = createHeuristicProvider();
    const before = await analyzeClause({ id: 'c', text: WORKED }, provider, {});
    const after = await analyzeClause({
      id: 'c',
      text: 'The service must retry a failed request up to three times in total, counting the first attempt.',
    }, provider, {});

    const b = before.axes.find((a) => a.id === 'boundary');
    const a = after.axes.find((a) => a.id === 'boundary');
    assert.equal(b.forked, true, 'must start forked');
    assert.equal(a.forked, false, 'must not stay forked');
    assert.equal(a.resolved, true, 'must converge on one reading');
    assert.equal(a.top.filter((r) => r.verdict === 'high').length, 1);
    assert.ok(a.top[1].noul < 0.2, 'the losing beam must go dark');
  });

  test('a document analysis carries the disclosure and a cost estimate', async () => {
    const out = await analyzeDocument(
      '4.2 ' + WORKED + '\n\n7.1 The system shall respond quickly to user actions.',
      createHeuristicProvider(),
      {},
    );
    assert.equal(out.clauses.length, 2);
    assert.match(out.disclosure, /recall is bounded/);
    assert.ok(out.cost.usd >= 0);
    assert.equal(out.synthetic, true);
  });

  test('no axis firing is reported as such, not as clean', async () => {
    const r = await analyzeClause({ id: 'c', text: 'Colourless green ideas sleep.' }, createHeuristicProvider(), {});
    assert.equal(r.noAxisFired, true);
    assert.equal(r.readings.length, 0);
  });
});
