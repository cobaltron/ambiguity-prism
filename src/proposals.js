// §5 source 2 — offline LLM reading proposals.
//
// The proposal step is NOT wired to a model here, by design: §5 requires the output
// to be "a reviewable JSON artifact, never generated at runtime". So this module
// only *reads* a reviewed artifact. Producing it is a human-in-the-loop offline
// step; see docs/proposals.md for the schema and the review checklist.
//
// Every loaded reading is linted like a templated one (§13), so an unreviewed or
// sloppy artifact cannot smuggle a negated, nested reading into a request.

/**
 * @typedef {{clause: string, readings: Array<{id:string,label:string,instructions:string}>, reviewedBy?: string, reviewedAt?: string}} ProposalEntry
 */

/**
 * @param {{entries?: ProposalEntry[]}|ProposalEntry[]|null|undefined} artifact
 * @param {string} clause
 * @returns {Array<{id:string, axis:string, label:string, instructions:string}>}
 */
export function loadProposals(artifact, clause) {
  if (!artifact) return [];
  const entries = Array.isArray(artifact) ? artifact : artifact.entries ?? [];
  const key = normalise(clause);
  const entry = entries.find((e) => normalise(e.clause) === key);
  if (!entry) return [];

  // An unreviewed entry is not usable: the artifact's whole purpose is that a human
  // signed off on the reading set.
  if (!entry.reviewedBy) return [];

  return (entry.readings ?? []).map((r, i) => ({
    id: r.id ?? 'proposed_' + i,
    axis: 'proposed',
    label: r.label ?? r.id ?? 'proposed reading ' + (i + 1),
    instructions: r.instructions,
    source: 'offline-proposal',
  }));
}

export function normalise(s) {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:]+$/, '').trim();
}

/** Shape check for the CLI, so a malformed artifact is reported rather than ignored. */
export function validateProposals(artifact) {
  const entries = Array.isArray(artifact) ? artifact : artifact?.entries ?? [];
  const problems = [];
  entries.forEach((e, i) => {
    if (!e.clause) problems.push('entry ' + i + ': missing clause');
    if (!Array.isArray(e.readings) || e.readings.length < 2) {
      problems.push('entry ' + i + ': needs at least two readings to show a fork');
    }
    if (!e.reviewedBy) problems.push('entry ' + i + ': not reviewed, will be ignored at runtime');
    (e.readings ?? []).forEach((r, j) => {
      if (!r.instructions) problems.push('entry ' + i + ' reading ' + j + ': missing instructions');
    });
  });
  return problems;
}
