// Minimal .env loader. No dependency, because pulling in a package to read
// key=value would be the only dependency in the project.
//
// Rules:
//   - a real environment variable always wins over the file, so
//     `TYPESAFE_API_KEY=... npm run serve` overrides .env without editing it
//   - the file is searched for from the working directory upward, so the CLI
//     works from a subdirectory
//   - values may be quoted; `export ` prefixes and `#` comments are tolerated
//   - a missing file is not an error

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * @param {string} [startDir]
 * @returns {{loaded: string|null, keys: string[]}}
 */
export function loadEnv(startDir = process.cwd()) {
  const path = findUp('.env', startDir);
  if (!path) return { loaded: null, keys: [] };

  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { loaded: null, keys: [] };
  }

  const keys = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    const [, key, rawValue] = match;
    let value = rawValue.trim();

    // Strip one layer of matching quotes. Inside double quotes, honour \n.
    if (/^"(.*)"$/s.test(value)) {
      value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else if (/^'(.*)'$/s.test(value)) {
      value = value.slice(1, -1);
    } else {
      // Unquoted: an inline comment ends the value.
      value = value.replace(/\s+#.*$/, '').trim();
    }

    // The real environment wins; .env only fills gaps.
    if (process.env[key] === undefined) {
      process.env[key] = value;
      keys.push(key);
    }
  }

  return { loaded: path, keys };
}

function findUp(filename, startDir) {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, filename);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Redacted form for logs: never print a key, only enough to recognise it. */
export function fingerprint(value) {
  if (!value) return 'unset';
  const s = String(value);
  if (s.length <= 8) return 'set (' + s.length + ' chars)';
  return s.slice(0, 4) + '…' + s.slice(-2) + ' (' + s.length + ' chars)';
}
