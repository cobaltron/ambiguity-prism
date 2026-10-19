// Cloudflare Workers port of server/proxy.js, for hosted demos.
//
// Same three endpoints, same single copy of the mechanism in src/. The UI is served
// from ui/ by the Workers static-assets binding, so the page and the API stay on one
// origin exactly as with the local proxy. TYPESAFE_API_KEY is a Worker secret
// (`wrangler secret put TYPESAFE_API_KEY`) and never reaches the page.

import { analyzeDocument } from '../src/analyze.js';
import { createProvider } from '../src/provider/index.js';
import { createMemoryCache } from '../src/cache.js';
import { thresholds, STANCES } from '../src/score.js';
import { ALL_AXES } from '../src/axes.js';

const MAX_BODY = 64 * 1024;

// Per-isolate: survives across requests while the isolate is warm, which is all the
// in-memory cache ever promised.
const cache = createMemoryCache();
let provider;

function getProvider(env) {
  if (provider) return provider;
  provider = createProvider(env.PRISM_PROVIDER ?? 'auto', {
    apiKey: env.TYPESAFE_API_KEY,
    baseUrl: env.TYPESAFE_API_BASE,
    model: env.TYPESAFE_MODEL,
    latencyMs: Number(env.PRISM_FAKE_LATENCY ?? 120),
  });
  return provider;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/v1/')) {
        const p = getProvider(env);
        if (request.method === 'GET' && url.pathname === '/v1/meta') return meta(p);
        if (request.method === 'POST' && url.pathname === '/v1/analyze') return await analyze(request, p);
        if (request.method === 'POST' && url.pathname === '/v1/systemone') return await systemone(request, p);
        return send(405, { error: 'method not allowed' });
      }
      return env.ASSETS.fetch(request);
    } catch (err) {
      return send(500, { error: err?.message ?? String(err) });
    }
  },
};

function meta(p) {
  return send(200, {
    provider: p.name,
    model: p.model,
    synthetic: Boolean(p.synthetic),
    hasKey: Boolean(p.hasKey),
    stances: STANCES,
    defaultStance: 'recall',
    axes: ALL_AXES.map((a) => ({
      id: a.id,
      label: a.label,
      describe: a.describe ?? null,
      lane: a.lane ?? 'interpretation',
    })),
    disclosure: 'detects interpretation ambiguity only; recall is bounded by the enumerated reading set',
    trust: 'absolute Nouls are comparative, not probabilities; never read as a percentage',
  });
}

async function analyze(request, p) {
  const body = await readJson(request);
  const text = String(body.text ?? '');
  if (!text.trim()) {
    return send(200, { clauses: [], summary: { clauses: 0, ambiguous: 0, underspecified: 0, uncertain: 0, clear: 0 }, revision: body.revision ?? 0 });
  }

  const analysis = await analyzeDocument(text, p, {
    cache,
    single: body.single !== false,
    thresholds: thresholds(body.stance ?? 'recall'),
    previous: body.previous ?? null,
    dismissed: body.dismissed ?? null,
  });

  return send(200, { ...analysis, revision: body.revision ?? 0 });
}

async function systemone(request, p) {
  const body = await readJson(request);
  const clause = body?.state?.clause ?? body?.state ?? '';
  const questions = body?.questions ?? {};
  const readings = Object.entries(questions).map(([id, q]) => ({
    id,
    instructions: typeof q === 'string' ? q : q.instructions,
  }));
  if (!readings.length) return send(400, { error: 'no questions' });

  const result = await p.evaluate(String(clause), readings);
  return send(200, {
    model: result.model,
    synthetic: Boolean(result.synthetic),
    latencyMs: result.latencyMs ?? null,
    nouls: Object.fromEntries(Object.entries(result.nouls).map(([k, v]) => [k, { noul: v }])),
  });
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new Error('body too large');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('invalid JSON body');
  }
}

function send(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
