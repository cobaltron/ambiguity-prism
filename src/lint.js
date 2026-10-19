// §13 — reading-string lint.
//
// Jev's indirection weakness punishes nested and double-negative phrasings, so a
// reading must be flat, direct and one hop. This is enforced on every reading,
// templated or proposed, before it is ever sent.

const NEGATIONS = [
  /\bnot\b/i, /\bno\b/i, /\bnone\b/i, /\bnever\b/i, /\bneither\b/i, /\bnor\b/i,
  /\bwithout\b/i, /\bexcept\b/i, /\bunless\b/i, /\black(?:s|ing)?\b/i,
  /\bfail(?:s|ing)? to\b/i, /n't\b/i, /\bun(?:able|clear|specified)\b/i,
];

const INDIRECTION = [
  /\bwould\b/i, /\bcould\b/i, /\bmight\b/i, /\bif .* then\b/i,
  /\bimpl(?:y|ies|ied)\b/i, /\bsuggests?\b/i, /\bseems?\b/i,
  /\bin other words\b/i, /\bthat is to say\b/i,
];

// The literal-reading preamble legitimately contains a conjunction, so the lint
// runs on the question only.
const PREAMBLE = /^Read the sentence literally, with no charity and no outside context\.\s*/;

const MAX_QUESTION_WORDS = 42;

/**
 * @param {{id?:string, instructions:string, lintExempt?:string}} reading
 * @returns {string[]} problems; empty means the reading is sendable
 */
export function lintReading(reading) {
  const problems = [];
  const raw = String(reading?.instructions ?? '');
  if (!raw.trim()) return ['empty instructions'];

  const question = raw.replace(PREAMBLE, '').trim();

  if (!question.includes('?')) problems.push('not phrased as a yes/no question');
  if ((question.match(/\?/g) ?? []).length > 1) problems.push('more than one question: one judgement per Noul (§6)');

  const words = question.split(/\s+/).filter(Boolean).length;
  if (words > MAX_QUESTION_WORDS) problems.push('question is ' + words + ' words; keep it under ' + MAX_QUESTION_WORDS);

  if (!reading.lintExempt) {
    const negations = NEGATIONS.filter((re) => re.test(question));
    if (negations.length) problems.push('negation in reading string (§13)');
    if (negations.length > 1) problems.push('double negative: Jev answers these badly');
  }

  const indirect = INDIRECTION.find((re) => re.test(question));
  if (indirect) problems.push('indirect phrasing; keep the reading one hop');

  // Two readings bundled into one question string (§6). Quoted phrases from the
  // clause itself are allowed, so only unquoted conjunctions count.
  const unquoted = question.replace(/"[^"]*"/g, '""');
  if (/\b(?:and|or)\b/i.test(unquoted) && !/\bin addition\b/i.test(unquoted) && !/\bboth of the\b/i.test(unquoted) && !/\bone of the\b/i.test(unquoted)) {
    problems.push('conjunction may bundle two readings into one Noul (§6)');
  }

  return problems;
}

/** Lint a whole battery; used by the CLI `lint` command and by tests. */
export function lintBattery(readings) {
  return readings
    .map((r) => ({ id: r.id, label: r.label, problems: lintReading(r) }))
    .filter((x) => x.problems.length);
}
