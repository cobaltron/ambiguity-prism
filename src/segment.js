// Clause segmentation. Code-side only (§3): Jev never sees the document, only one clause.
//
// Two jobs:
//   1. Split a document into sentence-sized clauses.
//   2. Attach a section label ("§4.2") when the source line carries one, so the
//      report in §9 can cite it.

const ABBREVIATIONS = new Set([
  'e.g', 'i.e', 'etc', 'vs', 'cf', 'resp', 'approx', 'fig', 'no', 'eq',
  'mr', 'mrs', 'ms', 'dr', 'prof', 'inc', 'ltd', 'al',
]);

// "4.2", "§7.1", "4.2.1" at the head of a line, with optional markdown bullet.
const SECTION_HEAD = /^\s*(?:[-*+]\s+)?(?:§\s*)?(\d+(?:\.\d+)+)\.?\s+/;
const BULLET_HEAD = /^\s*(?:[-*+]|\d+[.)])\s+/;
const MARKDOWN_NOISE = /^\s*(?:#{1,6}\s|```|\||>\s*$)/;

// Requirement keywords (RFC 2119 family). A line carrying one is a requirement
// line even if it is a fragment rather than a grammatical sentence.
const REQUIREMENT_KEYWORDS =
  /\b(?:must|shall|should|may|will|required|recommended|optional|prohibited)\b/i;

/**
 * Split one block of prose into sentences without breaking on known abbreviations,
 * decimal numbers, or version strings.
 * @param {string} block
 * @returns {Array<{text: string, start: number}>}
 */
export function splitSentences(block) {
  const out = [];
  let cursor = 0;

  for (let i = 0; i < block.length; i++) {
    const ch = block[i];
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;

    // A '.' between two digits is a decimal or a version, never a sentence end.
    if (ch === '.' && /\d/.test(block[i - 1] ?? '') && /\d/.test(block[i + 1] ?? '')) continue;

    if (ch === '.') {
      const word = /([A-Za-z.]+)$/.exec(block.slice(cursor, i))?.[1] ?? '';
      if (ABBREVIATIONS.has(word.toLowerCase().replace(/\.$/, ''))) continue;
      // Single capital letter before the dot: an initial ("J. Smith").
      if (/(?:^|\s)[A-Z]$/.test(block.slice(Math.max(0, i - 2), i))) continue;
    }

    // Consume trailing quotes/brackets, then require whitespace-or-end after.
    let end = i + 1;
    while (end < block.length && /["')\]]/.test(block[end])) end++;
    if (end < block.length && !/\s/.test(block[end])) continue;

    const text = block.slice(cursor, end).trim();
    if (text) out.push({ text, start: cursor });
    cursor = end;
  }

  const tail = block.slice(cursor).trim();
  if (tail) out.push({ text: tail, start: cursor });
  return out;
}

/**
 * Segment a whole document into clauses.
 * @param {string} doc
 * @returns {Array<{id: string, text: string, section: string|null, line: number, isRequirement: boolean}>}
 */
export function segment(doc) {
  const clauses = [];
  const lines = String(doc).replace(/\r\n?/g, '\n').split('\n');

  let section = null;
  let seq = 0;

  lines.forEach((rawLine, idx) => {
    const line = rawLine.trimEnd();
    if (!line.trim()) return;
    if (MARKDOWN_NOISE.test(line)) return;

    let body = line;
    const head = SECTION_HEAD.exec(line);
    if (head) {
      section = head[1];
      body = line.slice(head[0].length);
    } else if (BULLET_HEAD.test(line)) {
      body = line.replace(BULLET_HEAD, '');
    }

    body = stripInlineMarkup(body);
    if (!body.trim()) return;

    for (const sentence of splitSentences(body)) {
      const text = sentence.text.trim();
      if (countWords(text) < 3) continue;
      clauses.push({
        id: `c${++seq}`,
        text,
        section,
        line: idx + 1,
        isRequirement: REQUIREMENT_KEYWORDS.test(text),
      });
    }
  });

  return clauses;
}

/** Segment a single line typed into the prism UI. Always yields at least one clause. */
export function segmentLine(text) {
  const found = segment(text);
  if (found.length) return found;
  const trimmed = String(text).trim();
  return trimmed
    ? [{ id: 'c1', text: trimmed, section: null, line: 1, isRequirement: REQUIREMENT_KEYWORDS.test(trimmed) }]
    : [];
}

function stripInlineMarkup(s) {
  return s
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/(^|\W)[*_]([^*_]+)[*_](?=\W|$)/g, '$1$2')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
}

function countWords(s) {
  return (s.match(/[A-Za-z0-9]+/g) ?? []).length;
}

/** Short quotation for the report, elided in the middle like §9. */
export function quote(text, width = 52) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= width) return t;
  return `...${t.slice(0, width - 3).trimEnd()}...`;
}
