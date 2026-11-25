// Answers that cover whole documents ("summarise the report"), section by section. One long answer over the
// whole text dropped sections at random (the same request covered 15 sections one run and 12 the next), so the
// code splits each document by its own top-level sections, the model writes a few sections per call from their
// full text, and the code joins them in the document's order. A note on any section that revises another
// (an appendix superseding a policy) is passed to the section it revises.
import config from '../config.js';
import * as provider from './providers/ollama.js';
import { getAllPassagesDb, getSectionSummariesDb, getDocumentOverviewsDb } from '../db/chunksQueries.js';
import { stripFigureMarkers } from './figures.js';
import AppError from '../utils/AppError.js';
import { unsupportedNumbers, checkStatements, keepFlags } from './factCheck.js';

const { generateModel } = config.ollama;

// Documents up to this size are read in full; longer ones (a 300-page handbook) from their section summaries.
const FULL_TEXT_MAX = 150_000;
// Text per call. Smaller calls read more carefully; ~20k characters (~5k tokens) keeps several sections together.
const CALL_CHARS = 20_000;
// Section summaries shown when looking for sections that revise others.
const REVISION_SCAN_CHARS = 40_000;
const MAX_POINTS = 8;
const MAX_POINT_CHARS = 450;
const SKIPPED_HEADING_RE = /^(table of (contents|figures|tables|boxes)|contents|list of (figures|tables|boxes))$/i;
const PAGE_MARK_RE = /^\[p\. (\d+)\]$/;
const HEADING_RE = /^#{1,6}\s+(.+)$/;

// ── Splitting a document into its top-level sections ──

/**
 * The top-level section a heading starts, if any. "3. Financial Performance" and "3.2 Margins" belong to section 3;
 * "Appendix F: ..." starts appendix F. Inside the appendices, numbered headings are outlines within an appendix,
 * and an appendix letter must move forward (handbooks nest "Appendix A" outlines inside later appendices).
 */
function sectionOf(heading, current) {
  const appendix = heading.match(/^(?:appendix|annex)\s+([A-Z]{1,2}|\d+)\b/i);
  if (appendix) {
    const letter = appendix[1].toUpperCase();
    if (current?.appendix && letter <= current.appendix) return null;
    return { key: `appendix-${letter}`, appendix: letter, title: heading };
  }
  if (current?.appendix) return null;
  const numbered = heading.match(/^(\d{1,2})((?:\.\d+)*)\.?\s+\S/);
  if (!numbered) return null;
  const n = Number(numbered[1]);
  if (current?.number === n) return null;
  // "3.", "3.0" or "3.0.0 Title" names the section; "3.2 Margins" only tells us we are in section 3.
  const named = !numbered[2] || /^(\.0)+$/.test(numbered[2]);
  return { key: `s${n}`, number: n, title: named ? heading : null };
}

/** Splits passages (in reading order) into top-level sections, cutting a passage where a new section starts. */
export function splitIntoSections(passages) {
  const sections = [];
  let current = null;
  let skipping = false;
  let lastHeading = null;
  const open = (start) => {
    current = { ...start, pieces: [], firstPage: null, lastPage: null };
    sections.push(current);
  };
  for (const p of passages) {
    let page = p.page;
    let piece = [];
    const flush = () => {
      const text = piece.join('\n').trim();
      if (text && !skipping) {
        if (!current) open({ key: 'front', title: null });
        current.pieces.push({ page: piece.page ?? page, text, id: p.id });
        current.firstPage ??= piece.page ?? page;
        current.lastPage = page;
      }
      piece = [];
    };
    piece.page = page;
    // A heading that fell on a passage boundary is lost from the text but kept as the passage's label.
    const lines = decodeEntities(stripFigureMarkers(p.content)).split('\n');
    const label = p.heading && decodeEntities(p.heading).trim();
    if (label && label !== lastHeading && !lines.some((l) => l.match(HEADING_RE)?.[1].trim() === label)) {
      lines.unshift(`## ${label}`);
    }
    for (const line of lines) {
      const mark = line.trim().match(PAGE_MARK_RE);
      if (mark) { page = Number(mark[1]); piece.push(line); continue; }
      const h = line.match(HEADING_RE)?.[1].trim();
      if (h) lastHeading = h;
      if (h) {
        const starts = sectionOf(h, current);
        const skip = SKIPPED_HEADING_RE.test(h);
        if (!current && !starts && !skip) {
          flush();
          piece.page = page;
          // The opening's first heading is often a cover line ("NASA SP-2016-6105 Rev2 supersedes ..."): the
          // model titles it from its content instead.
          open({ key: 'front', title: null });
        } else if (starts || skip !== skipping) {
          flush();
          piece.page = page;
          skipping = skip;
          if (starts) {
            const known = sections.find((s) => s.key === starts.key);
            if (known) { current = known; known.title ??= starts.title; } else open(starts);
          }
        }
        if (current && !current.title && starts?.title) current.title = starts.title;
      }
      piece.push(line);
    }
    flush();
  }
  // Text before any heading and the first heading's part are both the opening: one section.
  const merged = [];
  for (const s of sections.filter((x) => x.pieces.length)) {
    const prev = merged[merged.length - 1];
    if (prev && prev.key === s.key) {
      prev.pieces.push(...s.pieces);
      prev.title ??= s.title;
      prev.lastPage = s.lastPage;
    } else merged.push(s);
  }
  return merged;
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/** Docling escapes some characters as HTML entities ("Research &amp; Development"). */
function decodeEntities(text) {
  return String(text).replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m]);
}

function sectionText(section) {
  return section.pieces.map((p) => `[p. ${p.page ?? '?'}]\n${p.text}`).join('\n\n');
}

/** For long documents: each section's stored summaries (by page), instead of its full text. */
function attachSummaries(sections, summaries) {
  for (const s of summaries) {
    const home = sections.find((sec) => s.page != null && sec.firstPage != null && s.page >= sec.firstPage && s.page <= sec.lastPage)
      || sections.findLast((sec) => sec.firstPage != null && s.page != null && sec.firstPage <= s.page);
    if (!home) continue;
    (home.summaries ||= []).push(`[p. ${s.page ?? '?'}] ${s.heading.replace(/^Summary:\s*/, '')}: ${s.content.replace(/\s+/g, ' ')}`);
  }
}

// ── Model calls ──

async function chatJson(system, user, format) {
  try {
    const t0 = Date.now();
    const reply = await provider.chat([{ role: 'system', content: system }, { role: 'user', content: user }], generateModel, { think: false, format });
    if (process.env.WD_DEBUG) console.error(`[wd] ${((Date.now() - t0) / 1000).toFixed(1)}s in ${user.length} out ${reply.content.length}: ${system.slice(0, 40)} | ${reply.content.replace(/\s+/g, ' ').slice(0, 300)}`);
    return JSON.parse(reply.content);
  } catch (error) {
    if (process.env.WD_DEBUG) console.error(`[wd] FAILED in ${user.length}: ${error.message}`);
    throw new AppError(`Writing the summary failed: ${error.message}`, 503, error);
  }
}

/**
 * Notes for sections another part of the document changes ("Appendix F supersedes Section 7.3"). The model answers
 * for each section in turn whether it changes another section; asked for an open list of changes across the whole
 * document, it returned none.
 */
export async function findRevisions(sections, material) {
  const each = Math.floor(REVISION_SCAN_CHARS / sections.length);
  const listing = sections.map((s, i) => `S${i + 1}. ${s.title || s.key}\n${material(s).slice(0, each)}`).join('\n\n');
  const ask = () => chatJson(
    `You read each part of a document and say whether it changes what ANOTHER part says: supersedes, amends, ` +
    `updates or corrects it (a revision appendix, an erratum, "this replaces section 4"). A part that only ` +
    `mentions or summarises another part does not change it.`,
    `${listing}\n\nFor every part, S1 to S${sections.length}, return: n, changes_another (true/false), revised ` +
    `(every section it changes, as the document names them, e.g. "Sections 7.2 and 7.3"; empty if none), change ` +
    `(every change it makes, each with what now applies, its numbers and dates; empty if none).`,
    {
      type: 'object',
      properties: { parts: { type: 'array', items: { type: 'object', properties: {
        n: { type: 'integer' }, changes_another: { type: 'boolean' }, revised: { type: 'string' }, change: { type: 'string' },
      }, required: ['n', 'changes_another', 'revised', 'change'] } } },
      required: ['parts'],
    },
  ).catch(() => ({ parts: [] }));
  // Asked once, it missed the Norvane revision appendix 1 run in 4; two asks, combined, rarely both miss.
  const answers = [...(await ask()).parts || [], ...(await ask()).parts || []];
  const found = new Map(); // revised section -> by section -> longest description
  for (const r of answers) {
    const by = sections[r.n - 1];
    if (!by || !r.changes_another || !r.change) continue;
    for (const revised of sectionsNamed(r.revised, sections)) {
      if (revised === by) continue;
      const mine = found.get(revised) || new Map();
      if ((mine.get(by) || '').length < r.change.length) mine.set(by, r.change);
      found.set(revised, mine);
    }
  }
  const notes = new Map();
  for (const [revised, bys] of found) {
    notes.set(revised, [...bys].map(([by, change]) => `${by.title || by.key} changes this section: ${change}`));
  }
  return notes;
}

/** The sections a reference like "Section 7.3", "7.2 and 7.3" or "Appendix B" points to. */
function sectionsNamed(ref, sections) {
  const found = new Set();
  for (const m of String(ref || '').matchAll(/\b(?:appendix|annex)\s+([A-Z]{1,2})\b|\b(\d{1,2})(?:\.\d+)*\b/gi)) {
    const key = m[1] ? `appendix-${m[1].toUpperCase()}` : `s${Number(m[2])}`;
    const s = sections.find((x) => x.key === key);
    if (s) found.add(s);
  }
  return [...found];
}

const WRITE_RULES =
  `Rules:\n` +
  `- Follow the user's request for language, length, format and detail. By default write 3-6 numbered points ` +
  `per section, one per line (1. 2. 3.), each a key fact, figure, decision or finding, and end each point with ` +
  `its page, e.g. (p. 4).\n` +
  `- Take pages from the [p. N] labels: text after a label is on that page.\n` +
  `- Copy numbers, names and dates exactly as written. Never add up, average, count or compare figures yourself: ` +
  `give a total, share, difference or count only when the text states it.\n` +
  `- For a table, log or list of many rows, say what it records (its columns, period and kinds of entries) and ` +
  `quote notable rows as they are. Never count its rows, or how many rows have some value, and never rank its ` +
  `rows (highest, lowest, most) unless the text itself does.\n` +
  `- Link causes and effects only as the text links them, and call something the largest, top or best only when ` +
  `the text says so.\n` +
  `- When a note says another part of the document changes this section, give the version that now applies and ` +
  `say what changed.\n` +
  `- Plain text: no markdown (no **, # or - bullets), and do not repeat the section's title or number.`;

function tidyText(text, title) {
  let t = String(text || '').trim()
    .replace(/^S\d+\.[^\n]*\n/, '') // an echoed "S2. Appendix E..." line
    .replace(/\*\*([^*]+)\*\*/g, '$1');
  if (title && t.startsWith(title)) t = t.slice(title.length).trim();
  // Points run together on one line ("1. ... 2. ...") go on their own lines.
  if (!t.includes('\n') && /^1\.\s/.test(t)) t = t.replace(/\s+(?=\d{1,2}\.\s+[A-Z(])/g, '\n');
  // The model sometimes loops (one appendix came back at 16,000 characters): no repeats, at most MAX_POINTS.
  const seen = new Set();
  const lines = t.split('\n').map((l) => l.trim()).filter((l) => {
    const key = l.replace(/^\d{1,2}\.\s*|^[-•]\s*/, '').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return lines.slice(0, MAX_POINTS).map((l) => (l.length > MAX_POINT_CHARS ? `${l.slice(0, MAX_POINT_CHARS).replace(/\s+\S*$/, '')}...` : l)).join('\n');
}

// A section that is mostly one long table (an incident log, a scorecard). The model miscounted the 49-row Norvane
// incident log on every run ("15 lost-time", "13 still open"), so the code counts its rows and says no other
// counts are known.
const MIN_TABLE_ROWS = 15;

export function tableNote(text) {
  const norm = (l) => l.replace(/\s+/g, ' ').trim();
  const lines = text.split('\n').filter((l) => l.trim());
  const isRow = (l) => /^\s*\|/.test(l);
  const isRule = (l) => /^\s*\|[\s|:-]+\|\s*$/.test(l);
  // Tables, by header: a table that continues on the next page repeats its header and joins up.
  const tables = new Map();
  let header = null;
  for (const l of lines) {
    if (!isRow(l)) { if (!/^\[p\. \d+\]$/.test(l.trim())) header = null; continue; }
    if (isRule(l)) continue;
    if (!header) { header = norm(l); if (!tables.has(header)) tables.set(header, new Set()); continue; }
    if (norm(l) !== header) tables.get(header).add(norm(l)); // passages overlap, so a row can appear twice
  }
  const largest = Math.max(0, ...[...tables.values()].map((t) => t.size));
  const tableLines = lines.filter(isRow).length;
  if (largest < MIN_TABLE_ROWS || tableLines < lines.length / 2) return '';
  return `This section is mainly a table of ${largest} rows. Say what it records and quote a few notable rows; ` +
    `the only count you know is ${largest} rows. Do not count rows by any value, and do not rank them.\n`;
}

async function writeSections(group, request, material, notes) {
  const untitled = group.some((s) => !s.title);
  const blocks = group.map((s, i) => {
    const n = notes.get(s);
    const text = material(s);
    return `### S${i + 1}. ${s.title || '(untitled section)'}\n` + (n ? `Notes: ${n.join(' ')}\n` : '') + tableNote(text) + text;
  }).join('\n\n');
  const result = await chatJson(
    `You summarise parts of a document for a user, one section at a time. ${WRITE_RULES}`,
    `The user's request: """${request}"""\n\nSections:\n\n${blocks}\n\n` +
    `Return one entry per section, S1 to S${group.length}: n (its number), ` +
    (untitled ? `title (a short title for an untitled section, from its content; otherwise its own title), ` : '') +
    `text (that section's summary).`,
    {
      type: 'object',
      properties: { sections: { type: 'array', minItems: group.length, maxItems: group.length, items: { type: 'object', properties: {
        n: { type: 'integer' }, ...(untitled ? { title: { type: 'string' } } : {}), text: { type: 'string' },
      }, required: ['n', ...(untitled ? ['title'] : []), 'text'] } } },
      required: ['sections'],
    },
  ).catch(() => ({ sections: [] }));
  const list = Array.isArray(result.sections) ? result.sections : [];
  const byN = new Map(list.map((x) => [x.n, x]));
  return group.map((s, i) => {
    const out = byN.get(i + 1) || list[i] || {};
    const offered = String(out.title || '').trim();
    const title = s.title || (offered && !/^S\d+\.?$/i.test(offered) ? offered : null);
    return { section: s, title, text: tidyText(out.text, title) };
  });
}

// ── Checking points against the source ──

/**
 * Drops points whose numbers the section's text (and its notes) never states. The model sums and counts on its
 * own despite the rules ("top five customers: 47%", "26 incidents", "average scrap rate 3.6%"); asked to correct
 * such a point, it pasted the source back instead, so a wrong figure is removed rather than repaired.
 */
function withoutUnsupported(w, source) {
  const lines = w.text.split('\n');
  const kept = lines.filter((l) => !l.trim() || !unsupportedNumbers(l, source).length);
  if (kept.filter((l) => l.trim()).length === 0) return w; // keep a section rather than empty it
  let k = 0;
  const renumbered = kept.map((l) => (/^\s*\d{1,2}\.\s/.test(l) ? l.replace(/^\s*\d{1,2}\./, `${++k}.`) : l));
  return { ...w, text: renumbered.join('\n'), dropped: lines.length - kept.length };
}

function pointsOf(text) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Drops points their section's text doesn't state (factCheck.js); one call per batch of sections. */
async function verifyPoints(written, material, notes) {
  const groups = written.map((w) => {
    const n = notes.get(w.section);
    return {
      label: w.title,
      source: `${n ? `Notes (also part of the text): ${n.join(' ')}\n` : ''}${material(w.section)}`,
      statements: pointsOf(w.text),
    };
  });
  const verdicts = await checkStatements(groups);
  return written.map((w, i) => {
    const points = groups[i].statements;
    if (!points.length) return w;
    const keep = keepFlags(verdicts[i]);
    let k = 0;
    const text = points.filter((_, j) => keep[j])
      .map((p) => (/^\d{1,2}\.\s/.test(p) ? p.replace(/^\d{1,2}\./, `${++k}.`) : p)).join('\n');
    return { ...w, text };
  });
}

async function writeOverview(request, docName, written) {
  const digest = written.map((w) => `${w.title}: ${w.text.replace(/\s+/g, ' ').slice(0, 400)}`).join('\n').slice(0, 12_000);
  const result = await chatJson(
    `You introduce a document summary in 2-3 sentences: what the document is (its title, author or organisation ` +
    `and period), then its 3-4 most important findings or figures, taken from the section summaries. Be ` +
    `specific: no general phrases like "covers key areas" or "provides comprehensive data". Follow the user's ` +
    `request for language. Plain text, no markdown. Copy numbers exactly; add no numbers of your own.`,
    `The user's request: """${request}"""\nDocument: ${docName}\n\nSection summaries:\n${digest}`,
    { type: 'object', properties: { overview: { type: 'string' } }, required: ['overview'] },
  ).catch(() => ({ overview: '' }));
  return String(result.overview || '').trim();
}

/** Packs sections into calls of about CALL_CHARS, in order. */
function packCalls(sections, material) {
  const calls = [];
  let group = [];
  let size = 0;
  for (const s of sections) {
    const len = material(s).length;
    if (group.length && size + len > CALL_CHARS) { calls.push(group); group = []; size = 0; }
    group.push(s);
    size += len;
  }
  if (group.length) calls.push(group);
  return calls;
}

// ── The answer ──

// An opening part this short is a title page; the overview covers it.
const MIN_OPENING_CHARS = 800;

/**
 * Covers whole documents, section by section.
 * @param {string} request  what the user asked (with any change they asked of the previous version)
 * @returns {Promise<{ content: string, sourceIds: number[] }>}
 */
export async function coverDocuments(docIds, request) {
  const docs = await getDocumentOverviewsDb(docIds);
  const parts = [];
  const ids = [];
  for (const doc of docs) {
    const passages = await getAllPassagesDb([doc.id]);
    if (!passages.length) continue;
    const sections = splitIntoSections(passages)
      .filter((s) => s.key !== 'front' || sectionText(s).length >= MIN_OPENING_CHARS);
    const total = passages.reduce((n, p) => n + p.content.length, 0);
    const full = total <= FULL_TEXT_MAX;
    // Long documents, and sections too long for one call, are read from their section summaries.
    if (!full || sections.some((s) => sectionText(s).length > CALL_CHARS)) {
      attachSummaries(sections, await getSectionSummariesDb([doc.id]));
    }
    const material = (s) => {
      const text = sectionText(s);
      if (full && text.length <= CALL_CHARS) return text;
      return s.summaries?.join('\n') || text.slice(0, CALL_CHARS);
    };
    const covered = sections.filter((s) => material(s).trim());

    const notes = await findRevisions(covered, material);
    const written = [];
    for (const group of packCalls(covered, material)) {
      let batch = await writeSections(group, request, material, notes);
      // A section the call returned empty gets a call of its own.
      for (let i = 0; i < batch.length; i++) {
        if (!batch[i].text) [batch[i]] = await writeSections([batch[i].section], request, material, notes);
      }
      batch = batch.map((w) => (w.text ? withoutUnsupported(w, material(w.section) + (notes.get(w.section) || []).join(' ')) : w));
      // Checked only against full text: against stored summaries every point lacks evidence.
      const fromText = batch.filter((w) => w.text && full && sectionText(w.section).length <= CALL_CHARS);
      const verified = new Map((await verifyPoints(fromText, material, notes)).map((w) => [w.section, w]));
      const checked = batch.filter((w) => w.text).map((w) => verified.get(w.section) || w);
      if (process.env.WD_DEBUG) console.error(`[wd] batch: ${batch.map((w) => `${(w.title || '?').slice(0, 14)}=${w.text.length}`).join(', ')} -> ${checked.map((w) => w.text.length).join(',')}`);
      written.push(...checked);
    }
    const named = written.map((w, i) => ({ ...w, title: w.title || `Section ${i + 1}` })).filter((w) => w.text);
    const overview = await writeOverview(request, doc.name, named);

    parts.push([
      docs.length > 1 ? `## ${doc.name.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ')}` : null,
      overview || null,
      ...named.map((w) => `### ${w.title}\n${w.text}`),
    ].filter(Boolean).join('\n\n'));
    ids.push(...covered.flatMap((s) => s.pieces.map((p) => p.id)));
  }
  // Passages remembered with the answer (a deck made next starts from them): spread through the documents.
  const step = Math.max(1, ids.length / 8);
  const sourceIds = [];
  for (let k = 0; k < ids.length && sourceIds.length < 8; k += step) sourceIds.push(ids[Math.floor(k)]);
  return { content: parts.join('\n\n'), sourceIds };
}
