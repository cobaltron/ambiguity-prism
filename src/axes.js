// §4 — the ambiguity axes for the REQUIREMENTS domain.
//
// Each axis has a trigger (code fires the axis only when its token is present)
// and a set of readings. Each reading becomes exactly one absolute Noul.
// To change domain (§11) swap this file and nothing else.
//
// Reading-string discipline (§5, §13): flat, direct, one hop, no negation and no
// conjunction. src/lint.js enforces it; `lintExempt` marks the few readings whose
// defect *is* an absence and so cannot be phrased positively.

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12,
};

const LITERAL = 'Read the sentence literally, with no charity and no outside context.';

/** @typedef {{id:string, axis:string, label:string, instructions:string, lintExempt?:string}} Reading */

export const AXES = [
  {
    id: 'boundary',
    label: 'Boundary inclusivity',
    describe: 'Does the count include the first attempt or not?',
    trigger(clause) {
      const m =
        /\b(?:up to|at most|no more than|as many as)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\b/i.exec(clause) ||
        /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+times?\b/i.exec(clause) ||
        /\bbetween\s+(\d+)\s+and\s+(\d+)\b/i.exec(clause);
      if (!m) return null;
      const token = String(m[1]).toLowerCase();
      const n = NUMBER_WORDS[token] ?? Number(token);
      if (!Number.isFinite(n)) return null;
      const range = /\bbetween\b/i.test(m[0]);
      return { match: m[0], n, range, verb: mainActionVerb(clause) };
    },
    readings({ n, range, verb }) {
      if (range) {
        return [
          mk('boundary_inclusive', 'boundary', 'range endpoints included',
            LITERAL + ' Does the sentence allow the stated endpoint numbers themselves as valid values?'),
          mk('boundary_exclusive', 'boundary', 'range endpoints excluded',
            LITERAL + ' Does the sentence treat the stated endpoint numbers as values that fall outside the allowed range?'),
        ];
      }
      const act = verb ?? 'occurrences of the described action';
      return [
        mk('boundary_extra', 'boundary', n + ' after the first (' + (n + 1) + ' total)',
          LITERAL + ' Does the sentence require at most ' + n + ' ' + act + ' in ADDITION to the first one, for ' + (n + 1) + ' in total?'),
        mk('boundary_total', 'boundary', n + ' in total (' + Math.max(n - 1, 0) + ' after the first)',
          LITERAL + ' Does the sentence require at most ' + n + ' ' + act + ' in TOTAL, counting the first one?'),
      ];
    },
  },

  {
    id: 'obligation',
    label: 'Obligation strength',
    describe: 'Binding requirement, or a recommendation?',
    trigger(clause) {
      const m = /\b(must|shall|should|may|ought to|is to|will|required|recommended|optional)\b/i.exec(clause);
      if (!m) return null;
      const word = m[1].toLowerCase();
      // must / shall / required and optional / recommended are settled by RFC-2119
      // convention; they are still evaluated so the axis can confirm a clean clause,
      // but only the hedges are expected to fork.
      const hedge = ['should', 'may', 'ought to', 'is to', 'will'].includes(word);
      return { match: m[0], word, hedge };
    },
    readings() {
      return [
        mk('oblig_mandatory', 'obligation', 'mandatory',
          LITERAL + ' Does the sentence make the described behavior mandatory?'),
        mk('oblig_optional', 'obligation', 'recommended but optional',
          LITERAL + ' Does the sentence present the described behavior as a recommendation that an implementer is free to skip?'),
      ];
    },
  },

  {
    id: 'coordination',
    label: 'Coordination scope',
    describe: 'Inclusive or exclusive "or"?',
    trigger(clause) {
      if (/\b(?:more or less|or so|either way|sooner or later)\b/i.test(clause)) return null;
      const m = /\b(and\/or|or)\b/i.exec(clause);
      if (!m) return null;
      return { match: m[1] };
    },
    readings() {
      return [
        mk('coord_inclusive', 'coordination', 'inclusive or (either, possibly both)',
          LITERAL + ' Does the sentence allow both of the coordinated alternatives to hold at the same time?'),
        mk('coord_exclusive', 'coordination', 'exclusive or (exactly one)',
          LITERAL + ' Does the sentence require exactly one of the coordinated alternatives to hold?'),
      ];
    },
  },

  {
    id: 'quantifier',
    label: 'Quantifier scope',
    describe: 'Does the modifier cover every X, or only the qualified ones?',
    trigger(clause) {
      const m = /\b(all|each|every|any)\s+([A-Za-z][\w-]*(?:\s+[a-z][\w-]*)?)\s+(that|which|who|with|having)\b/i.exec(clause);
      if (!m) return null;
      return { match: m[0], quant: m[1].toLowerCase(), noun: m[2], rel: m[3].toLowerCase() };
    },
    readings({ noun, rel }) {
      const head = noun.toLowerCase();
      return [
        mk('quant_wide', 'quantifier', 'applies to all ' + head,
          LITERAL + ' Does the stated requirement apply to every ' + head + ' mentioned in the sentence?'),
        mk('quant_narrow', 'quantifier', 'applies only to the qualified ' + head,
          LITERAL + ' Does the stated requirement apply only to the ' + head + ' described by the "' + rel + '" phrase?'),
      ];
    },
  },

  {
    id: 'attachment',
    label: 'Modifier attachment',
    describe: 'Does the modifier attach to the near term or the far term?',
    trigger(clause) {
      // Requires a determiner-led noun phrase: DET MODIFIER NOUN NOUN.
      // Without the determiner anchor this pattern cheerfully reads verbs and
      // function words as nouns ("requested resource does" -> "does").
      ADJ_COMPOUND.lastIndex = 0;
      let m;
      while ((m = ADJ_COMPOUND.exec(clause))) {
        const [, , modifier, near, far] = m;
        if (STOP_MODIFIERS.has(modifier.toLowerCase())) continue;
        if (!isOpenClassNoun(near) || !isOpenClassNoun(far)) continue;
        if (near.toLowerCase() === far.toLowerCase()) continue;
        ADJ_COMPOUND.lastIndex = 0;
        return { match: m[0], modifier, near, far };
      }
      return null;
    },
    readings({ modifier, near, far }) {
      const mod = modifier.toLowerCase();
      const phrase = mod + ' ' + near + ' ' + far;
      return [
        mk('attach_near', 'attachment', '"' + mod + '" modifies ' + near.toLowerCase(),
          LITERAL + ' In the phrase "' + phrase + '", does the word "' + mod + '" describe the ' + near.toLowerCase() + '?'),
        mk('attach_far', 'attachment', '"' + mod + '" modifies ' + far.toLowerCase(),
          LITERAL + ' In the phrase "' + phrase + '", does the word "' + mod + '" describe the ' + far.toLowerCase() + '?'),
      ];
    },
  },

  {
    id: 'reference',
    label: 'Reference',
    describe: 'Which earlier noun does the pronoun point at?',
    trigger(clause) {
      // Every anaphor in the clause is considered, not just the first: a definite
      // description ("the request") often appears BEFORE the pronoun that is
      // actually unresolved ("...must retry it"), and taking the first match would
      // truncate the candidate window to nothing. The anaphor with the most
      // visible antecedents wins; later beats earlier on a tie.
      ANAPHOR.lastIndex = 0;
      let best = null;
      let m;
      while ((m = ANAPHOR.exec(clause))) {
        const candidates = nounCandidates(clause.slice(0, m.index));
        if (candidates.length < 2) continue;           // one antecedent cannot fork

        // A definite description that names exactly one visible candidate is not
        // anaphoric at all: "...must retry the request" IS the disambiguation an
        // author writes instead of "retry it". Firing here would flag the fix.
        const described = /^the\s+(.+)$/i.exec(m[1])?.[1]?.toLowerCase();
        if (described) {
          const naming = candidates.filter((c) => c === described || c.endsWith(' ' + described));
          if (naming.length === 1) continue;
        }
        if (!best || candidates.length >= best.candidates.length) {
          best = { match: m[1], pronoun: m[1].toLowerCase(), candidates: candidates.slice(-3) };
        }
      }
      return best;
    },
    readings({ pronoun, candidates }) {
      return candidates.map((cand, i) =>
        mk('ref_' + i, 'reference', '"' + pronoun + '" = ' + cand,
          LITERAL + ' In this sentence, does the word "' + pronoun + '" refer to the ' + cand + '?'));
    },
  },
];

// Separate lane (§4): a different defect — underspecification, not ambiguity.
// The fix is a number, not a disambiguation, so it never enters the fork test.
export const VAGUENESS = {
  id: 'vagueness',
  label: 'Vagueness',
  lane: 'vagueness',
  describe: 'A performance or quality term with no measurable threshold.',
  terms: [
    'quickly', 'fast', 'rapidly', 'promptly', 'soon', 'timely', 'periodically',
    'appropriate', 'appropriately', 'reasonable', 'reasonably', 'adequate',
    'sufficient', 'sufficiently', 'efficient', 'efficiently', 'robust', 'scalable',
    'minimal', 'user-friendly', 'intuitive', 'as needed', 'where possible',
    'best effort', 'high performance', 'frequently', 'rarely', 'gracefully',
  ],
  trigger(clause) {
    const lower = clause.toLowerCase();
    const term = VAGUENESS.terms.find((t) =>
      new RegExp('(?:^|[^\\w-])' + escapeRe(t) + '(?:[^\\w-]|$)').test(lower));
    if (!term) return null;
    // A measurable threshold in the same clause discharges the vagueness.
    if (HAS_THRESHOLD.test(clause)) return null;
    return { match: term, term };
  },
  readings({ term }) {
    return [
      mk('vague_term', 'vagueness', '"' + term + '" has no measurable threshold',
        LITERAL + ' The sentence uses the word "' + term + '" to describe required performance. Does the sentence lack a measurable numeric threshold for that word?',
        'the defect is an absence, so it cannot be phrased without a negative'),
    ];
  },
};

// A number with a unit, a percentage, a comparison or a percentile counts as measurable.
const HAS_THRESHOLD =
  /\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|sec|secs|seconds?|min|mins|minutes?|hours?|days?|%|percent|requests?|bytes?|kb|mb|gb|items?|rps|qps)\b|[<>]=?\s*\d|\bpercentile\b|\bp9[59]\b/i;

const ADJ_SUFFIX = '(?:ed|ing|able|ible|ive|ous|al|ic|ary|ful|less)';
const ADJ_WORDS = 'failed|valid|invalid|secure|encrypted|signed|expired|active|inactive|remote|local|public|private|stale|partial|complete|duplicate|legacy';
// determiner + modifier + two bare nouns: "the queued request log".
const ADJ_COMPOUND = new RegExp(
  '\\b(the|a|an|its|their|each|every|any|all|this|that)\\s+' +
  '((?:[a-z]+' + ADJ_SUFFIX + '|' + ADJ_WORDS + '))\\s+' +
  '([a-z][a-z-]{2,})\\s+([a-z][a-z-]{2,})\\b',
  'gi',
);

// Closed-class words and common verbs the noun slots must not contain. The
// attachment axis is the one axis with no reliable surface signal, so it is
// deliberately the most conservative: a missed attachment ambiguity is reported
// as bounded recall (§13), while a false one trains the author to ignore the tool.
const NOT_A_NOUN = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'by', 'from',
  'at', 'as', 'into', 'over', 'under', 'after', 'before', 'during', 'while', 'than',
  'that', 'which', 'who', 'when', 'where', 'if', 'then', 'else', 'not', 'no',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did',
  'has', 'have', 'had', 'must', 'shall', 'should', 'may', 'might', 'will', 'would',
  'can', 'could', 'it', 'its', 'this', 'these', 'those', 'they', 'them', 'their',
  'all', 'any', 'each', 'every', 'both', 'such', 'same', 'other', 'first', 'next',
  'more', 'most', 'less', 'least', 'only', 'also', 'very', 'so', 'but', 'because',
  'exist', 'exists', 'occur', 'occurs', 'apply', 'applies', 'return', 'returns',
]);

function isOpenClassNoun(word) {
  const w = String(word).toLowerCase();
  return w.length >= 3 && !NOT_A_NOUN.has(w);
}

// Words the -ing/-ed pattern catches that are verbs or function words, not modifiers.
const STOP_MODIFIERS = new Set([
  'during', 'following', 'including', 'regarding', 'pending', 'according', 'depending',
  'provided', 'based', 'used', 'called', 'named', 'given', 'required', 'allowed',
  'defined', 'described', 'specified', 'expected', 'returned', 'received', 'sent',
  'general', 'additional', 'individual', 'optional', 'single', 'possible', 'available',
  'must', 'will', 'shall', 'before', 'after', 'while', 'being',
]);

const STOP_NOUNS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'by', 'from',
  'that', 'which', 'when', 'if', 'is', 'are', 'be', 'been', 'has', 'have', 'had',
  'must', 'shall', 'should', 'may', 'will', 'can', 'not', 'it', 'its', 'this', 'these',
  'those', 'they', 'their', 'same', 'such', 'other', 'first', 'next', 'above',
]);

const ANAPHOR =
  /\b(it|its|they|them|their|this|that|these|those|the (?:resource|request|response|value|item|record|object|entry|message))\b/gi;

/**
 * Visible noun-phrase candidates, left to right, for the reference axis.
 * Two-word phrases are kept only when the second word is itself noun-like, so
 * "the gateway shall" yields "gateway" rather than "gateway shall".
 */
function nounCandidates(before) {
  const out = [];
  const re = /\b(?:the|a|an|its|their|each|every)\s+([a-z][\w-]*)(?:\s+([a-z][\w-]*))?/gi;
  let m;
  while ((m = re.exec(before))) {
    const first = m[1].toLowerCase();
    const second = m[2]?.toLowerCase();
    let phrase;
    if (second && isOpenClassNoun(second) && !STOP_NOUNS.has(second)) {
      phrase = first + ' ' + second;       // "primary server"
    } else if (isOpenClassNoun(first) && !STOP_NOUNS.has(first)) {
      phrase = first;                       // "gateway"
    } else {
      continue;
    }
    if (!out.includes(phrase)) out.push(phrase);
  }
  return out;
}

/** Best guess at the action being counted; makes boundary readings concrete. */
function mainActionVerb(clause) {
  const m = /\b(?:must|shall|should|may|will|can)\s+(?:not\s+)?([a-z]+)\b/i.exec(clause);
  if (!m) return null;
  const v = m[1].toLowerCase();
  if (v.endsWith('y')) return v.slice(0, -1) + 'ies';
  if (/(?:s|sh|ch|x|z)$/.test(v)) return v + 'es';
  return v + 's';
}

function mk(id, axis, label, instructions, lintExempt) {
  const reading = { id, axis, label, instructions };
  if (lintExempt) reading.lintExempt = lintExempt;
  return reading;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const INTERPRETATION_AXES = AXES;
export const ALL_AXES = [...AXES, VAGUENESS];
export const AXES_BY_ID = new Map(ALL_AXES.map((a) => [a.id, a]));
