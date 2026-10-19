// Provider selection + the proxy-backed provider used by the browser.
//
// THERE IS NO FALLBACK. Without a key, every entry point fails loudly with
// instructions. It used to substitute an offline rule table so the pipeline could
// run key-less, and the risk that buys is a demo quietly showing invented numbers
// with the real model's name next to them. A hard failure cannot be misread.
//
// The offline judge survives only as an explicitly requested test double
// (`--provider heuristic` / `PRISM_PROVIDER=heuristic`), which the test suite and
// `prism probe` use to exercise the mechanism without burning calls. It is never
// selected on your behalf.

import { createJevProvider, PINNED_MODEL, missingKeyMessage } from './jev.js';
import { createHeuristicProvider } from './heuristic.js';

export { PINNED_MODEL };

/**
 * @param {'jev'|'heuristic'|'auto'} [name] `auto` and `jev` both mean Jev.
 * @throws when Jev is selected and no key is available.
 */
export function createProvider(name = 'auto', opts = {}) {
  if (name === 'heuristic') return createHeuristicProvider(opts);

  if (name === 'auto' || name === 'jev') {
    const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY;
    if (!apiKey) throw new Error(missingKeyMessage());
    return createJevProvider({ ...opts, apiKey });
  }

  throw new Error('unknown provider: ' + name + ' (expected jev or heuristic)');
}

/**
 * Browser-side provider. Talks to the local proxy, which holds the key (§12);
 * the key never reaches the page.
 */
export function createProxyProvider(opts = {}) {
  const endpoint = opts.endpoint ?? '/v1/systemone';
  return {
    name: 'proxy',
    model: opts.model ?? PINNED_MODEL,
    requiresKey: false,
    hasKey: true,
    async evaluate(clause, readings, ctx = {}) {
      const questions = {};
      for (const r of readings) questions[r.id] = { type: 'noul', instructions: r.instructions };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: { clause }, questions }),
        signal: ctx.signal,
      });
      if (!res.ok) throw new Error('proxy ' + res.status + ' ' + res.statusText);
      const json = await res.json();
      const nouls = {};
      for (const key of Object.keys(questions)) {
        const cell = json?.answers?.[key] ?? json?.nouls?.[key];
        const value = typeof cell === 'number' ? cell : cell?.noul;
        if (typeof value === 'number') nouls[key] = value;
      }
      return { nouls, model: json.model, latencyMs: json.latencyMs ?? 0, synthetic: Boolean(json.synthetic) };
    },
  };
}
