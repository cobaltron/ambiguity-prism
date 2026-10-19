import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadEnv, fingerprint } from '../src/env.js';

const KEYS = ['TYPESAFE_API_KEY', 'TYPESAFE_API_BASE', 'TYPESAFE_MODEL', 'PRISM_PORT', 'QUOTED', 'SPACED', 'INLINE'];

/** Run loadEnv against a throwaway directory with a clean environment. */
function withEnvFile(contents, fn, { preset = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'prism-env-'));
  writeFileSync(join(dir, '.env'), contents, 'utf8');

  const saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, preset);
  try {
    return fn(loadEnv(dir), dir);
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe('.env loading', () => {
  test('reads a simple key=value', () => {
    withEnvFile('TYPESAFE_API_KEY=abc123\n', (result) => {
      assert.equal(process.env.TYPESAFE_API_KEY, 'abc123');
      assert.ok(result.loaded?.endsWith('.env'));
      assert.ok(result.keys.includes('TYPESAFE_API_KEY'));
    });
  });

  test('a real environment variable wins over the file', () => {
    withEnvFile('TYPESAFE_API_KEY=from-file\n', () => {
      assert.equal(process.env.TYPESAFE_API_KEY, 'from-shell',
        'the shell must override .env so a one-off run needs no file edit');
    }, { preset: { TYPESAFE_API_KEY: 'from-shell' } });
  });

  test('tolerates comments, blanks, export prefixes and quotes', () => {
    const file = [
      '# a comment',
      '',
      'export TYPESAFE_API_KEY=exported-value',
      'QUOTED="double quoted"',
      "SPACED  =  spaced-out  ",
      'INLINE=value # trailing comment',
      'NOT A VALID LINE',
    ].join('\n');
    withEnvFile(file, () => {
      assert.equal(process.env.TYPESAFE_API_KEY, 'exported-value');
      assert.equal(process.env.QUOTED, 'double quoted');
      assert.equal(process.env.SPACED, 'spaced-out');
      assert.equal(process.env.INLINE, 'value');
    });
  });

  test('does not strip a # that is part of the value when quoted', () => {
    withEnvFile('TYPESAFE_API_KEY="k#ey#123"\n', () => {
      assert.equal(process.env.TYPESAFE_API_KEY, 'k#ey#123');
    });
  });

  test('finds .env from a subdirectory, searching upward', () => {
    withEnvFile('TYPESAFE_API_KEY=found-upward\n', (_result, dir) => {
      const nested = join(dir, 'a', 'b');
      mkdirSync(nested, { recursive: true });
      delete process.env.TYPESAFE_API_KEY;
      const result = loadEnv(nested);
      assert.equal(process.env.TYPESAFE_API_KEY, 'found-upward');
      assert.ok(result.loaded);
    });
  });

  test('a missing file is not an error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prism-noenv-'));
    const result = loadEnv(dir);
    assert.equal(result.loaded, null);
    assert.deepEqual(result.keys, []);
  });
});

describe('key fingerprint', () => {
  test('never reveals the whole key', () => {
    const key = 'sk-live-abcdefghijklmnop';
    const print = fingerprint(key);
    assert.ok(!print.includes('abcdefghijklmnop'));
    assert.match(print, /^sk-l…op \(\d+ chars\)$/);
  });

  test('reports an unset key plainly', () => {
    assert.equal(fingerprint(undefined), 'unset');
  });

  test('does not partially reveal a very short value', () => {
    assert.equal(fingerprint('abc'), 'set (3 chars)');
  });
});
