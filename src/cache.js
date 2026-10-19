// §12 — content-addressed cache on (pinned model, clause hash, reading-set hash).
//
// All three go into the key, so a model bump, a clause edit or an axis-table change
// each miss cleanly instead of serving a stale fork. Re-runs are free and
// deterministic within the cache lifetime.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function sha(...parts) {
  const h = createHash('sha256');
  for (const p of parts) h.update(String(p), 'utf8');
  return h.digest('hex');
}

/** The reading set is hashed by id + exact instruction text, order-independent. */
export function readingSetHash(readings) {
  const fingerprint = readings
    .map((r) => r.id + '\u0000' + r.instructions)
    .sort()
    .join('\u0001');
  return sha(fingerprint);
}

export function cacheKey(model, clause, readings) {
  return sha(model, '\u0000', sha(clause.trim()), '\u0000', readingSetHash(readings));
}

/** In-memory cache; fine for a session and for the UI. */
export function createMemoryCache() {
  const map = new Map();
  return {
    name: 'memory',
    get: (key) => map.get(key) ?? null,
    set: (key, value) => void map.set(key, value),
    get size() { return map.size; },
    stats: { hits: 0, misses: 0 },
  };
}

/**
 * JSON-file cache for CLI runs, so `accept` plus a re-run only pays for changed
 * clauses. Written atomically-ish on flush, not per entry.
 */
export function createFileCache(dir = '.cache') {
  const path = join(dir, 'nouls.json');
  let map = new Map();
  let dirty = false;

  if (existsSync(path)) {
    try {
      map = new Map(Object.entries(JSON.parse(readFileSync(path, 'utf8'))));
    } catch {
      map = new Map(); // a corrupt cache is a cold cache, never a crash
    }
  }

  return {
    name: 'file:' + path,
    get: (key) => map.get(key) ?? null,
    set(key, value) {
      map.set(key, value);
      dirty = true;
    },
    get size() { return map.size; },
    stats: { hits: 0, misses: 0 },
    flush() {
      if (!dirty) return;
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, JSON.stringify(Object.fromEntries(map), null, 0), 'utf8');
      dirty = false;
    },
  };
}

export function createNullCache() {
  return {
    name: 'none',
    get: () => null,
    set: () => {},
    size: 0,
    stats: { hits: 0, misses: 0 },
  };
}
