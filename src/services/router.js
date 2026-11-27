// Decides what a chat message asks for: an answer, a deck/document (a skill), or a change to the deck or
// document being edited. Most messages are plain questions; a cheap text check skips the model for those, so
// only messages that could be requests cost one small structured call.
import config from '../config.js';
import { generateStructured } from './llm.js';

const MAKE_RE = /\b(make|create|turn|generate|build|draft|produce|prepare|put together|design|write|give me|i need|can you do)\b/i;
const ARTIFACT_RE = /\b(deck|slides?|presentation|ppt|powerpoint|document|doc|guide|manual|handout|handbook|reference sheet|training material)\b/i;
const QUESTION_RE = /\?\s*$|^\s*(what|why|how|when|where|which|who|whose|does|do|did|is|are|was|were|can|could|should|would|explain|tell me|list|compare|summari[sz]e)\b/i;
const ITEM_RE = /\b(slide|section)\s+(\d{1,2})\b/i;

const INTENTS = {
  question: 'a question about the documents, to be answered',
  deck: 'asks to make a new slide deck / presentation',
  doc: 'asks to make a new training document, guide, manual or handout',
  edit: 'asks to change the deck/document being edited (wording, content, layout, adding or removing slides)',
};

/** Whether a message might be anything other than a question (when nothing is being edited). */
export function mightBeRequest(text) {
  return MAKE_RE.test(text) && ARTIFACT_RE.test(text);
}

/** The 1-based slide/section number a message names ("slide 3"), if any. */
export function namedItem(text) {
  const m = text.match(ITEM_RE);
  return m ? Number(m[2]) : null;
}

/**
 * The intent of a message. editing: a deck/document is open for changes, so "edit" is possible.
 * @returns {Promise<'question'|'deck'|'doc'|'edit'>}
 */
export async function routeMessage(text, { editing }) {
  if (!editing && !mightBeRequest(text)) return 'question';
  // While editing, an instruction is an edit; only questions and requests for something new need the model.
  if (editing && !QUESTION_RE.test(text) && !mightBeRequest(text)) return 'edit';

  const options = Object.keys(INTENTS).filter((k) => editing || k !== 'edit');
  const prompt =
    `Classify this message from a user working with their documents${editing ? ' while a deck/document is open for editing' : ''}.\n\n` +
    `Message: """${text}"""\n\n` +
    options.map((k) => `${k}: ${INTENTS[k]}`).join('\n') +
    (editing ? '\n\nWhile editing, a question about the content is a question.' : '');
  try {
    const { intent } = await generateStructured(prompt, config.ollama.generateModel, {
      type: 'object', properties: { intent: { type: 'string', enum: options } }, required: ['intent'],
    }, { think: false });
    return options.includes(intent) ? intent : (editing ? 'edit' : 'question');
  } catch {
    return editing ? 'edit' : 'question';
  }
}
