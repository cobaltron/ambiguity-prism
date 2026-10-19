// §6 — the Jev provider. One batched request per clause; every applicable reading
// is an absolute Noul evaluated in parallel against the same state.
//
// THE SINGLE SWAP POINT (§12). Everything above this file deals in
// {readingId -> raw noul}. This is the only code that knows about the network.
//
// Verified against the published API (2026-10-05):
//
//   POST https://api.typesafe.ai/v1/systemone
//   Authorization: Bearer $TYPESAFE_API_KEY
//   { "model": "jev-1.13.0", "state": …, "questions": { "<key>": { "type": "noul",
//     "instructions": "…" } } }
//   -> { "model": "jev-1.13.0",
//        "answers": { "<key>": { "type": "noul", "noul": 0.95 } },
//        "usage": { "input_tokens": 296, "output_tokens": 20 } }
//
// NOTE: the design document's §6 snippet reads `result.nouls[k].noul`. The real
// response nests answers under `answers`, not `nouls`. The reader below prefers
// `answers` and still accepts `nouls` so the doc's shape does not hard-fail.

export const PINNED_MODEL = 'jev-1.13.0'; // §12: never jev-latest.

const DEFAULT_BASE = 'https://api.typesafe.ai';
const PATH = '/v1/systemone';

// §12: 1,200 requests/min and 250,000 tokens/sec; a 429 over either. 529 is the
// documented "provider overloaded". Both are retried with backoff; 401 and 422 are
// not retried, because resending an unchanged bad request cannot help.
const RETRY_STATUS = new Set([429, 529]);
const NO_RETRY_STATUS = new Set([400, 401, 403, 404, 422]);

export function createJevProvider(opts = {}) {
  const base = (opts.baseUrl ?? process.env.TYPESAFE_API_BASE ?? DEFAULT_BASE).replace(/\/+$/, '');
  const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY ?? null;
  const model = opts.model ?? process.env.TYPESAFE_MODEL ?? PINNED_MODEL;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const maxRetries = opts.maxRetries ?? 3;

  if (model === 'jev-latest' || model === 'jev-preview') {
    // Both aliases currently resolve to 1.13, but they are aliases: a silent bump
    // would invalidate every threshold and every cache entry at once (§12).
    throw new Error(
      'Refusing the alias "' + model + '": pin an exact version (e.g. ' + PINNED_MODEL + '). ' +
      'A silent version bump invalidates thresholds and cache together (§12).',
    );
  }

  return {
    name: 'jev',
    model,
    baseUrl: base,
    requiresKey: true,
    hasKey: Boolean(apiKey),

    /**
     * @param {string} clause        state — ONLY the clause (§6)
     * @param {Array<{id:string, instructions:string}>} readings
     * @param {{signal?: AbortSignal}} [ctx]
     * @returns {Promise<{nouls: Record<string, number>, model: string, latencyMs: number, usage: object|null}>}
     */
    async evaluate(clause, readings, ctx = {}) {
      if (!apiKey) throw new Error(missingKeyMessage());
      if (!readings.length) return { nouls: {}, model, latencyMs: 0, usage: null };

      // One question per reading. Never bundle two readings into one string (§6).
      const questions = {};
      for (const r of readings) questions[r.id] = { type: 'noul', instructions: r.instructions };

      const body = JSON.stringify({
        model,
        state: { clause },   // only the clause: accuracy falls as state grows (§6)
        questions,
      });

      const started = Date.now();
      let lastErr;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const timer = new AbortController();
        const onAbort = () => timer.abort(ctx.signal?.reason);
        ctx.signal?.addEventListener('abort', onAbort, { once: true });
        const to = setTimeout(() => timer.abort(new Error('jev request timed out')), timeoutMs);
        try {
          const res = await fetch(base + PATH, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: 'Bearer ' + apiKey,
            },
            body,
            signal: timer.signal,
          });

          if (RETRY_STATUS.has(res.status) || (res.status >= 500 && !NO_RETRY_STATUS.has(res.status))) {
            const retryAfter = Number(res.headers.get('retry-after'));
            const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter * 1000
              : Math.min(4000, 250 * 2 ** attempt) + Math.random() * 150;
            lastErr = new Error('jev ' + res.status + ' ' + res.statusText);
            if (attempt < maxRetries) {
              await sleep(waitMs, ctx.signal);
              continue;
            }
            throw lastErr;
          }

          if (!res.ok) {
            const detail = await res.text().catch(() => '');
            const err = new Error(describeHttpError(res, detail));
            // Flagged so the catch below rethrows instead of retrying: resending an
            // unchanged request that was rejected on its merits cannot succeed.
            err.noRetry = true;
            err.status = res.status;
            throw err;
          }

          const json = await res.json();
          return {
            nouls: readNouls(json, Object.keys(questions)),
            model: json.model ?? model,
            latencyMs: Date.now() - started,
            // Real token counts, so cost reporting stops being an estimate.
            usage: json.usage ?? null,
          };
        } catch (err) {
          if (ctx.signal?.aborted) throw err;          // superseded revision (§8)
          if (err?.noRetry) throw err;                 // 401/422/404 and friends
          lastErr = err;
          if (attempt >= maxRetries) throw err;
          await sleep(Math.min(4000, 250 * 2 ** attempt), ctx.signal);
        } finally {
          clearTimeout(to);
          ctx.signal?.removeEventListener('abort', onAbort);
        }
      }
      throw lastErr ?? new Error('jev request failed');
    },
  };
}

/**
 * Pull raw absolute Nouls out of the response.
 *
 * Real shape is `answers[key].noul`; the design doc's `nouls[key].noul` and a bare
 * number are also accepted. A missing key is an error, not a zero — a silent zero
 * would read as "this reading does not hold", which is a different claim from
 * "we did not ask".
 */
export function readNouls(json, keys) {
  const container =
    json?.answers ??
    json?.result?.answers ??
    json?.nouls ??
    json?.result?.nouls ??
    json;

  const out = {};
  const missing = [];
  for (const key of keys) {
    const cell = container?.[key];
    const value = typeof cell === 'number' ? cell : cell?.noul ?? cell?.value;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      missing.push(key);
      continue;
    }
    out[key] = value; // raw. Do NOT normalize (§6).
  }
  if (missing.length) {
    throw new Error(
      'jev response missing nouls for: ' + missing.join(', ') +
      '. Response keys: ' + Object.keys(container ?? {}).join(', '),
    );
  }
  return out;
}

function describeHttpError(res, detail) {
  const tail = detail ? ': ' + detail.slice(0, 300) : '';
  if (res.status === 401) {
    return 'jev 401 Unauthorized — TYPESAFE_API_KEY is missing, wrong or revoked' + tail;
  }
  if (res.status === 422) {
    return 'jev 422 Unprocessable — the request shape was rejected (check question type "noul")' + tail;
  }
  if (res.status === 404) {
    return 'jev 404 Not Found — wrong endpoint. Expected POST <base>/v1/systemone' + tail;
  }
  return 'jev ' + res.status + ' ' + res.statusText + tail;
}

export function missingKeyMessage() {
  return [
    'TYPESAFE_API_KEY is not set.',
    '',
    'Put it in a .env file at the project root:',
    '    TYPESAFE_API_KEY=your-key-here',
    '',
    'or export it for this shell:',
    '    $env:TYPESAFE_API_KEY = "your-key-here"      # PowerShell',
    '    export TYPESAFE_API_KEY=your-key-here        # bash',
    '',
    'Copy .env.example to .env to get started. Keys: https://jevplayground.com/jev-api',
  ].join('\n');
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error('aborted'));
    }, { once: true });
  });
}
