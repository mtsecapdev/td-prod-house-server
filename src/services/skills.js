// Skills: things the chat can make (a slide deck, a training document) from what was discussed.
// A skill turns the conversation into a brief for the planner and pins the passages the answers used, so the
// plan starts from what the user actually read and asked about, not just a topic line.
import config from '../config.js';
import { generateStructured } from './llm.js';
import { KINDS } from './planning/kinds.js';

export const SKILLS = ['deck', 'doc', 'image'];

const RECENT_MESSAGES = 14;
const MESSAGE_CHARS = 1200;
const PINNED_FROM_ANSWERS = 4; // the last few answers' passages
const MAX_PINNED = 16;
// A user message this long is their own material (notes, a draft) rather than a question.
const OWN_TEXT_CHARS = 1500;

// Phrases from the questions below; an answer containing one is the question copied back.
const ECHO_RE = /1-3 sentences|if they said|if they did not say|Empty if|0 if they/i;

const BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    topic: { type: 'string' },
    audience: { type: 'string' },
    tone: { type: 'string' },
    instructions: { type: 'string' },
    count: { type: 'integer' },
  },
  required: ['topic', 'audience', 'tone', 'instructions', 'count'],
};

/** The recent conversation as plain text (earlier skill requests left out). */
export function transcript(messages) {
  return messages
    // Earlier "make a deck…" requests belong to what they made (their length, their audience), not this one.
    .filter((m) => m.kind === 'text' && m.content.trim() && !m.data?.skill)
    .slice(-RECENT_MESSAGES)
    .map((m) => {
      const text = m.content.trim();
      return `${m.role === 'user' ? 'User' : 'Assistant'}: ${text.length > MESSAGE_CHARS ? `${text.slice(0, MESSAGE_CHARS)}…` : text}`;
    })
    .join('\n\n');
}

/** Passages used by the latest answers, most recent first. */
function pinnedPassages(messages) {
  const ids = [];
  const answers = messages.filter((m) => m.role === 'assistant' && m.kind === 'text').slice(-PINNED_FROM_ANSWERS).reverse();
  for (const m of answers) for (const id of m.data?.source_ids || []) if (!ids.includes(id)) ids.push(id);
  return ids.slice(0, MAX_PINNED);
}

/**
 * The brief for a deck/document made from this conversation.
 * @param {object[]} messages  the conversation so far (oldest first)
 * @param {'deck'|'doc'} type
 * @param {string} request  what the user typed with the skill (may be empty)
 */
export async function briefFromConversation(messages, type, request = '') {
  const kind = KINDS[type];
  const history = transcript(messages);
  if (!history && !request.trim()) {
    throw Object.assign(new Error(`Say what the ${kind.product} should cover`), { statusCode: 400 });
  }

  const prompt =
    `A user has been working with their documents in a chat and now wants a ${kind.product} made from it.\n\n` +
    (history ? `The conversation:\n"""\n${history}\n"""\n\n` : '') +
    `What they asked for just now: ${request.trim() || `(nothing more: make the ${kind.product} from the conversation)`}\n\n` +
    `Answer these questions about the ${kind.product} they want, using only what they said:\n` +
    `topic: In 1-3 sentences, what should it cover? Name the subject and the specific points they asked about; ` +
    `if the request just now narrows or changes that, follow it.\n` +
    `audience: Who is it for, if they said (for example "new hires")? Empty if they did not say.\n` +
    `tone: What tone did they ask for? Empty if none.\n` +
    `instructions: What did they ask to include, stress or avoid? Empty if nothing.\n` +
    `count: How many ${kind.nounPlural} did they ask for? 0 if they did not say.`;
  let brief = await generateStructured(prompt, config.ollama.generateModel, BRIEF_SCHEMA, { think: false });
  // Without thinking the model occasionally copies the questions into the answers; think it through then.
  if (Object.values(brief).some((v) => typeof v === 'string' && ECHO_RE.test(v))) {
    brief = await generateStructured(prompt, config.ollama.generateModel, BRIEF_SCHEMA, { think: true });
  }

  // The user's own material (pasted notes, a draft) is planned from as written.
  const ownText = messages.filter((m) => m.role === 'user' && m.kind === 'text' && m.content.length >= OWN_TEXT_CHARS).slice(-1)[0];
  const [min, max] = kind.countRange;
  return {
    topic: brief.topic.trim() || request.trim(),
    audience: brief.audience.trim(),
    tone: brief.tone.trim(),
    instructions: brief.instructions.trim(),
    ...(brief.count >= min && brief.count <= max ? { count: brief.count } : {}),
    pinned_chunk_ids: pinnedPassages(messages),
    ...(ownText ? { source_text: ownText.content } : {}),
  };
}
