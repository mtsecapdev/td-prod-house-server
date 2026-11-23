// Checks written text against its sources, for everything the model writes from documents (chat summaries,
// slides, document sections). Two checks:
// - numbers: a number the source never states was added up, counted or guessed ("top five customers: 47%",
//   "an 8.2% rise the year before"). Cheap and exact, done in code.
// - statements: the model, shown the source and one statement at a time, says whether the source states it.
//   It writes counts, rankings and causal links on its own ("the yield gain lifted gross margin", "Brandt
//   succeeds Vercoe") but rejects most of them when checking: in testing it caught 8-9 of 9 such errors.
// Asked to rewrite a wrong statement, it pasted the source back instead, so wrong statements are removed.
import config from '../config.js';
import * as provider from './providers/ollama.js';

const { generateModel } = config.ollama;

// ── Numbers ──

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

export function numbersIn(text) {
  const out = new Set();
  const plain = String(text)
    .replace(/\(p\.\s*\d+(?:\s*[-–,]\s*\d+)*\)/g, ' ') // page references
    .replace(/\[p\.\s*\d+\]/g, ' ')
    .replace(/^\s*\d{1,2}[.)]\s+/gm, ' '); // list numbering
  // Numbers inside codes ("ALX-18", "TR-240", "Ti-6Al-4V", "CMSX-4") are names, not figures.
  for (const m of plain.matchAll(/(?<![A-Za-z]-?)\d[\d,]*(?:\.\d+)?/g)) {
    const n = m[0].replace(/,$/, '').replace(/,/g, '');
    out.add(n.includes('.') ? n.replace(/\.?0+$/, '') : n.replace(/^0+(?=\d)/, ''));
  }
  return out;
}

function sourceNumbers(text) {
  const nums = numbersIn(text);
  // The same figure in other units: "2,177" EUR k written as 2,177,000 or 2.177 million, and back.
  for (const n of [...nums]) {
    const v = Number(n);
    if (!Number.isFinite(v)) continue;
    for (const scaled of [v * 1000, v * 1e6, v / 1000, v / 1e6]) {
      const str = String(Number(scaled.toFixed(6)));
      if (/[1-9]/.test(str)) nums.add(str);
    }
  }
  const lower = String(text).toLowerCase();
  NUMBER_WORDS.forEach((w, i) => { if (new RegExp(`\\b${w}\\b`).test(lower)) nums.add(String(i)); });
  return nums;
}

/** Numbers in written text that its source never states. */
export function unsupportedNumbers(written, source) {
  const known = sourceNumbers(source);
  return [...numbersIn(written)].filter((n) => !known.has(n));
}

// ── Statements ──

const VERIFY_RULES =
  `You fact-check statements against the source text they were written from. For each statement, first copy ` +
  `the shortest exact phrase or table cells from the source that state it (evidence, at most 12 words), then ` +
  `decide. A statement that restates a sentence or a table row correctly is supported. A statement is NOT ` +
  `supported when no sentence or row states it: it counts rows or items the source does not count, adds up, ` +
  `averages or compares figures, calls something the highest, lowest, only, most or largest when the source ` +
  `does not say so, links a cause or effect the source does not link, connects people, products or events the ` +
  `source does not connect, claims a trend or comparison with no figure for it, or gets a number, name or date ` +
  `wrong. A statement that makes no factual claim (a transition such as "Next, we look at...", a question to ` +
  `the audience, a pointer to another slide or section) is supported.`;

function samePercent(text) {
  return String(text).replace(/(\d)\s*per ?cent\b/gi, '$1%');
}

async function askVerdicts(groups) {
  const items = [];
  groups.forEach((g, gi) => g.statements.forEach((text, k) => items.push({ gi, k, id: `S${gi + 1}.P${k + 1}`, text })));
  const out = groups.map((g) => g.statements.map(() => null));
  if (!items.length) return out;
  // Sources spell out "41 percent" where the text writes "41%"; the checker took that for a mismatch.
  const blocks = groups.map((g, gi) => `### Source S${gi + 1}${g.label ? `: ${g.label}` : ''}\n${samePercent(g.source)}`).join('\n\n');
  let verdicts;
  try {
    const reply = await provider.chat([
      { role: 'system', content: VERIFY_RULES },
      {
        role: 'user',
        content: `${blocks}\n\nStatements to check (S1.P2 is statement 2 written from source S1):\n` +
          `${items.map((it) => `${it.id}. ${it.text}`).join('\n')}\n\nFor every statement return id (as given), ` +
          `evidence (at most 12 words copied from its source; empty if none) and supported (true/false).`,
      },
    ], generateModel, {
      think: false,
      format: {
        type: 'object',
        properties: { points: { type: 'array', items: { type: 'object', properties: {
          id: { type: 'string' }, evidence: { type: 'string' }, supported: { type: 'boolean' },
        }, required: ['id', 'evidence', 'supported'] } } },
        required: ['points'],
      },
    });
    const list = JSON.parse(reply.content).points || [];
    verdicts = new Map(list.map((v) => [String(v.id).trim(), v]));
    // One statement: whatever id the model wrote, its one verdict is for it.
    if (items.length === 1 && list.length === 1) verdicts.set(items[0].id, list[0]);
  } catch (err) {
    console.warn(`Fact check skipped: ${err.message}`);
    return out;
  }
  for (const it of items) {
    const v = verdicts.get(it.id);
    out[it.gi][it.k] = v ? { supported: v.supported !== false, evidence: String(v.evidence || '').trim() } : null;
  }
  return out;
}

/**
 * Whether each statement is stated by its source. groups: [{ label, source, statements: [string] }].
 * All statements are checked in one call; those it rejects are asked again one at a time, and only a statement
 * both reject counts as unsupported. Checked together, the model rejected correct statements whose evidence it
 * had just quoted ("41% renewable, up from 33%"); checked alone it judged 10 of 12 test statements right against
 * 8 of 12, at under a second each. findMore(statement) can add passages about it from elsewhere in the document
 * for that second look. Returns, per group, { supported, evidence } per statement (null: unchecked).
 */
export async function checkStatements(groups, { findMore } = {}) {
  const verdicts = await askVerdicts(groups);
  for (let gi = 0; gi < groups.length; gi++) {
    for (let k = 0; k < groups[gi].statements.length; k++) {
      if (verdicts[gi][k]?.supported !== false) continue;
      const statement = groups[gi].statements[k];
      // The second look also gets the document's passages about this statement: it may come from another page.
      const more = findMore ? await findMore(statement).catch(() => '') : '';
      const source = more ? `${groups[gi].source}\n\n${more}` : groups[gi].source;
      const [[again]] = await askVerdicts([{ ...groups[gi], source, statements: [statement] }]);
      if (again?.supported) verdicts[gi][k] = again;
    }
  }
  return verdicts;
}

/**
 * Which statements to keep, given their verdicts: the supported ones (and unchecked ones). A group is never
 * emptied: when every statement fails, those with evidence stay, and if none has any, all stay (a checker that
 * found nothing at all has failed, not the text).
 */
export function keepFlags(verdicts) {
  const keep = verdicts.map((v) => v?.supported !== false);
  if (keep.some(Boolean) || !verdicts.length) return keep;
  const withEvidence = verdicts.map((v) => Boolean(v?.evidence));
  return withEvidence.some(Boolean) ? withEvidence : verdicts.map(() => true);
}

/** Splits prose into sentences ("p. 4" and "1.3" don't end one). */
export function sentencesOf(text) {
  return String(text || '').split(/(?<=[.!?])\s+(?=[A-Z"“'(])/).map((s) => s.trim()).filter(Boolean);
}
