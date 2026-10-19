// §9 triage persistence — accept / dismiss. All code-side; the model is never
// tuned against the user, and nothing here changes how a Noul is evaluated.
//
//   accept       records a clause as reviewed, keyed by its content hash. Combined
//                with the §12 cache, a re-run only pays for changed clauses — and
//                because the key is the clause text, editing the clause revokes
//                the acceptance automatically.
//   dismiss      suppresses one templated axis, per clause or per document, for
//                teams whose house style settles that axis (e.g. "up to N" always
//                means inclusive).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sha } from './cache.js';

const FILE = 'review.json';

export function createReviewStore(dir = '.prism') {
  const path = join(dir, FILE);
  let data = { version: 1, accepted: {}, dismissed: { '*': [] } };

  if (existsSync(path)) {
    try {
      const loaded = JSON.parse(readFileSync(path, 'utf8'));
      data = { ...data, ...loaded, dismissed: { '*': [], ...(loaded.dismissed ?? {}) } };
    } catch {
      // A corrupt review file must not block analysis; it is advisory state.
    }
  }

  function save() {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
  }

  return {
    path,

    /** Acceptance is keyed by clause text, so an edit silently revokes it. */
    accept(clauseText, note) {
      data.accepted[sha(clauseText.trim())] = {
        clause: clauseText.trim(),
        at: new Date().toISOString(),
        note: note ?? null,
      };
      save();
    },

    isAccepted(clauseText) {
      return Boolean(data.accepted[sha(clauseText.trim())]);
    },

    /** scope is a clause id, a clause hash, or '*' for the whole document. */
    dismiss(axisId, scope = '*') {
      const key = scope === '*' ? '*' : sha(String(scope).trim());
      data.dismissed[key] ??= [];
      if (!data.dismissed[key].includes(axisId)) data.dismissed[key].push(axisId);
      save();
    },

    undismiss(axisId, scope = '*') {
      const key = scope === '*' ? '*' : sha(String(scope).trim());
      data.dismissed[key] = (data.dismissed[key] ?? []).filter((a) => a !== axisId);
      save();
    },

    /** Shape expected by analyze(): { '*': [...], '<clauseHash>': [...] }. */
    dismissedMap() {
      return data.dismissed;
    },

    dismissedFor(clauseText) {
      return [...(data.dismissed['*'] ?? []), ...(data.dismissed[sha(clauseText.trim())] ?? [])];
    },

    summary() {
      return {
        accepted: Object.keys(data.accepted).length,
        dismissedGlobally: data.dismissed['*'] ?? [],
        scopes: Object.keys(data.dismissed).filter((k) => k !== '*').length,
      };
    },
  };
}
