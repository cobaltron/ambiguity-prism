// §12 — the local proxy. Holds TYPESAFE_API_KEY so it never reaches the page, and
// serves the prism UI from the same origin (no CORS, no preflight on the hot path).
//
// Endpoints:
//   GET  /v1/meta        provider, model, thresholds, axis table (for the legend)
//   POST /v1/analyze     text -> fully scored clause. The UI's hot path.
//   POST /v1/systemone   the raw §6 shape: {state, questions} -> {nouls}
//
// /v1/analyze exists so the browser never re-implements segmentation, routing or
// scoring: there is exactly one copy of the mechanism, and the UI renders it.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnv, fingerprint } from '../src/env.js';
import { analyzeDocument } from '../src/analyze.js';
import { createProvider } from '../src/provider/index.js';
import { createMemoryCache } from '../src/cache.js';
import { thresholds, STANCES } from '../src/score.js';
import { ALL_AXES } from '../src/axes.js';

// .env before any process.env read.
const env = loadEnv();

const PORT = Number(process.env.PRISM_PORT ?? 8787);
const HOST = process.env.PRISM_HOST ?? '127.0.0.1';
const UI_DIR = fileURLToPath(new URL('../ui/', import.meta.url));

let provider;
try {
  provider = createProvider(process.env.PRISM_PROVIDER ?? 'auto', {
    latencyMs: Number(process.env.PRISM_FAKE_LATENCY ?? 120),
  });
} catch (err) {
  // No key: say so plainly and stop. The server does not start in a degraded
  // mode, because a running prism that shows invented numbers under the real
  // model's name is worse than one that refuses to start.
  console.error(err.message);
  console.error('');
  console.error(env.loaded
    ? 'Loaded .env from ' + env.loaded + ' (it set: ' + (env.keys.join(', ') || 'nothing') + ')'
    : 'No .env file found from ' + process.cwd() + ' upward.');
  process.exit(1);
}
const cache = createMemoryCache();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

const MAX_BODY = 64 * 1024; // §12: 64k token context; a clause is ~220 tokens

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://' + (req.headers.host ?? HOST));

    if (req.method === 'GET' && url.pathname === '/v1/meta') return meta(res);
    if (req.method === 'POST' && url.pathname === '/v1/analyze') return await analyze(req, res);
    if (req.method === 'POST' && url.pathname === '/v1/systemone') return await systemone(req, res);
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(url.pathname, res);

    send(res, 405, { error: 'method not allowed' });
  } catch (err) {
    send(res, 500, { error: err?.message ?? String(err) });
  }
});

function meta(res) {
  send(res, 200, {
    provider: provider.name,
    model: provider.model,
    // The page shows a banner whenever this is true. The mechanism is the same
    // either way; the numbers are not.
    synthetic: Boolean(provider.synthetic),
    hasKey: Boolean(provider.hasKey),
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

async function analyze(req, res) {
  const body = await readJson(req);
  const text = String(body.text ?? '');
  if (!text.trim()) {
    return send(res, 200, { clauses: [], summary: { clauses: 0, ambiguous: 0, underspecified: 0, uncertain: 0, clear: 0 }, revision: body.revision ?? 0 });
  }

  const analysis = await analyzeDocument(text, provider, {
    cache,
    single: body.single !== false,
    thresholds: thresholds(body.stance ?? 'recall'),
    // Carries the beams' current lit state so hysteresis is evaluated against what
    // the user is actually looking at (§8), not against a fresh render.
    previous: body.previous ?? null,
    dismissed: body.dismissed ?? null,
  });

  // The revision travels back out so the client can discard a stale response (§8).
  send(res, 200, { ...analysis, revision: body.revision ?? 0 });
}

/** The literal §6 request shape, for parity with the design doc and for curl. */
async function systemone(req, res) {
  const body = await readJson(req);
  const clause = body?.state?.clause ?? body?.state ?? '';
  const questions = body?.questions ?? {};
  const readings = Object.entries(questions).map(([id, q]) => ({
    id,
    instructions: typeof q === 'string' ? q : q.instructions,
  }));
  if (!readings.length) return send(res, 400, { error: 'no questions' });

  const result = await provider.evaluate(String(clause), readings);
  send(res, 200, {
    model: result.model,
    synthetic: Boolean(result.synthetic),
    latencyMs: result.latencyMs ?? null,
    // Documented shape: result.nouls[key].noul
    nouls: Object.fromEntries(Object.entries(result.nouls).map(([k, v]) => [k, { noul: v }])),
  });
}

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  // Contain the path inside ui/ before touching the disk.
  const target = normalize(join(UI_DIR, rel));
  if (!target.startsWith(normalize(UI_DIR))) return send(res, 403, { error: 'forbidden' });
  try {
    const file = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(file);
  } catch {
    send(res, 404, { error: 'not found: ' + rel });
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (err) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

server.listen(PORT, HOST, () => {
  console.log('Ambiguity Prism — http://' + HOST + ':' + PORT);
  console.log('provider: ' + provider.name + '  model: ' + provider.model);
  if (provider.baseUrl) console.log('endpoint: ' + provider.baseUrl + '/v1/systemone');
  if (env.loaded) console.log('env:      ' + env.loaded);
  console.log('key:      ' + fingerprint(process.env.TYPESAFE_API_KEY));
  if (provider.synthetic) {
    console.log('');
    console.log('  EXPLICIT TEST DOUBLE (PRISM_PROVIDER=heuristic).');
    console.log('  Values come from a rule table, not a model, and are marked');
    console.log('  synthetic everywhere. Unset PRISM_PROVIDER to use Jev.');
    console.log('');
  }
});

export { server };
