// The chat workspace: conversations over documents, where decks and training documents are made (skills) and
// then changed by asking. Messages are stored one per row by the server, so the browser never sends history.
import responseFactory from '../utils/responseFactory.js';
import AppError from '../utils/AppError.js';
import {
  listConversationsDb, getConversationDb, createConversationDb, updateConversationDb, deleteConversationDb,
  adoptGenerationDb,
} from '../db/conversationsQueries.js';
import { listMessagesDb, insertMessageDb, getMessageDb, updateMessageDataDb } from '../db/messagesQueries.js';
import { getGenerationByIdDb, isJobLive, presentGeneration } from '../db/generationsQueries.js';
import { answerQuestion } from '../services/answer.js';
import { SKILLS } from '../services/skills.js';
import { routeMessage, namedItem } from '../services/router.js';
import { createPlan } from '../services/planning/outlineJob.js';
import { kindOf } from '../services/planning/kinds.js';
import { editItem, insertItem } from '../services/planning/itemOps.js';
import { planAgent, applyAgent, undoAgent } from '../services/planning/agent.js';
import { startJob } from '../services/jobs.js';
import { deleteDiagrams } from '../services/diagrams.js';
import { ownDocumentIds } from '../middleware/auth.js';
import { startInterview, answerInterview, skipRest, reask, briefFromInterview } from '../services/interview.js';
import { openEventStream } from '../utils/eventStream.js';

const HISTORY_MESSAGES = 10;

/** A deck/document the signed-in user owns ("not found" otherwise). */
async function ownGeneration(req, id) {
  const generation = await getGenerationByIdDb(Number(id) || 0).catch(() => null);
  if (!generation || generation.owner_id !== req.user.id) throw new AppError('Deck or document not found', 404);
  return generation;
}
const TITLE_CHARS = 60;

const titleFrom = (text) => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > TITLE_CHARS ? `${t.slice(0, TITLE_CHARS - 1)}…` : t || 'New chat';
};

async function listConversations(req, res) {
  res.json(responseFactory.createJsonResponse({ conversations: await listConversationsDb(req.user.id) }));
}

async function getConversation(req, res) {
  const conversation = await getConversationDb(req.params.id);
  res.json(responseFactory.createJsonResponse({ conversation, messages: await listMessagesDb(conversation.id) }));
}

// { title?, docIds?, generationId? }. With generationId, a deck/document made before conversations existed
// gets one (same documents), so it can be changed by chatting like any other.
async function createConversation(req, res) {
  const { docIds = [], generationId } = req.body || {};
  let title = req.body?.title;
  let documentIds = docIds;
  let generation = null;
  if (generationId) {
    generation = presentGeneration(await ownGeneration(req, generationId));
    kindOf(generation); // decks and documents only
    if (generation.conversation_id) {
      return res.json(responseFactory.createJsonResponse({ conversation: await getConversationDb(generation.conversation_id) }));
    }
    title = title || generation.name;
    documentIds = generation.source_document_ids || [];
  }
  const conversation = await createConversationDb(titleFrom(title || 'New chat'), await ownDocumentIds(req.user.id, documentIds), req.user.id);
  if (generation) {
    await adoptGenerationDb(conversation.id, generation.id);
    await insertMessageDb(conversation.id, {
      role: 'assistant', kind: 'generation', data: { generation_id: generation.id, type: generation.type },
    });
  }
  res.status(201).json(responseFactory.createJsonResponse({ conversation }));
}

async function updateConversation(req, res) {
  const { title, docIds } = req.body || {};
  const conversation = await updateConversationDb(req.params.id, {
    title: title === undefined ? undefined : titleFrom(title),
    // Only the user's own documents can be worked with.
    docIds: Array.isArray(docIds) ? await ownDocumentIds(req.user.id, docIds) : undefined,
  });
  res.json(responseFactory.createJsonResponse({ conversation }));
}

// Deleting a conversation deletes what was made in it (copies saved to the Library are separate files).
async function deleteConversation(req, res) {
  const generationIds = await deleteConversationDb(req.params.id);
  await Promise.all(generationIds.map((id) => deleteDiagrams(id).catch(() => {})));
  res.json(responseFactory.createJsonResponse({ deleted: true, generations: generationIds.length }));
}

// ── Messages ──

/**
 * POST { content, target? } as a server-sent stream: { phase } updates, then { phase: 'done', messages }.
 * Without a target the message is a question about the documents. With target { generationId, index?, after? }
 * it is a change to that deck/document: one item (index), a new item after `after`, or the whole thing (a
 * proposal the user applies from the chat).
 */
async function sendMessage(req, res) {
  const conversation = await getConversationDb(req.params.id);
  const content = String(req.body?.content || '').trim();
  if (!content) throw new AppError('Write a message', 400);
  const target = req.body?.target?.generationId ? req.body.target : null;
  // A change can only target a deck/document of this conversation.
  if (target && (await ownGeneration(req, target.generationId)).conversation_id !== conversation.id) {
    throw new AppError('That deck or document is not part of this conversation', 400);
  }

  const { send, end } = openEventStream(res);

  const previous = await listMessagesDb(conversation.id);
  const userMessage = await insertMessageDb(conversation.id, {
    role: 'user', content, data: target ? { target: { generation_id: Number(target.generationId), index: target.index, after: target.after } } : {},
  });
  if (conversation.title === 'New chat' && !target) await updateConversationDb(conversation.id, { title: titleFrom(content) });

  let reply;
  let sent = userMessage;
  const onPhase = (phase) => send({ phase });
  // While the planning interview is asking a question, a message is the answer.
  const interview = !target && activeInterview(previous);
  try {
    if (interview?.kind === 'interview') {
      onPhase('interview');
      reply = await answerInterview(interview.data.interview, content, req.body?.picked ?? null);
      await closeInterview(interview);
    } else {
      // A plain message may ask for a deck/document; while editing, it may be a question instead.
      const intent = await routeMessage(content, { editing: Boolean(target) });
      if (intent === 'deck' || intent === 'doc') {
        sent = await updateMessageDataDb(userMessage.id, { skill: intent });
        onPhase('skill');
        reply = await startPlanning(conversation, previous, intent, content);
      } else if (intent === 'edit' && target) {
        reply = await changeGeneration(target, content, onPhase);
      } else {
        reply = await answer(conversation, previous, content, onPhase);
      }
    }
  } catch (err) {
    reply = { kind: 'error', content: err.message };
  }
  const assistantMessage = await insertMessageDb(conversation.id, { role: 'assistant', ...reply });
  send({ phase: 'done', messages: [sent, assistantMessage] });
  end();
}

async function answer(conversation, previous, question, onPhase) {
  if (!conversation.doc_ids?.length) throw new Error('Choose the documents to work with first (📎 Documents).');
  // Only the question-and-answer turns: requests to make or change things would steer the answer's form.
  const history = previous
    .filter((m) => m.kind === 'text' && !m.data?.skill && !m.data?.target)
    .slice(-HISTORY_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content }));
  const lastAnswer = previous.findLast((m) => m.role === 'assistant' && m.kind === 'text');
  const result = await answerQuestion({
    question, history, docIds: conversation.doc_ids, onPhase, lastWholeDocument: lastAnswer?.data?.whole_document,
  });
  return {
    kind: 'text',
    content: result.content,
    data: {
      figures: result.figures, grounded: result.grounded, source_ids: result.sourceIds,
      ...(result.wholeDocument ? { whole_document: result.wholeDocument } : {}),
    },
  };
}

async function changeGeneration(requested, instruction, onPhase) {
  const generation = await getGenerationByIdDb(requested.generationId);
  const kind = kindOf(generation);
  if (isJobLive(generation.job)) throw new Error(`Still working on the ${generation.job.kind}. Ask again when it finishes.`);
  const items = generation.outline?.[kind.listKey] || [];
  const base = { generation_id: generation.id };
  // "Shorten slide 3" asked of the whole deck is a change to slide 3.
  const named = namedItem(instruction);
  const target = (requested.index === undefined || requested.index === null) && (requested.after === undefined || requested.after === null) && named && items[named - 1]
    ? { ...requested, index: named - 1 }
    : requested;

  if (target.after !== undefined && target.after !== null) {
    onPhase('writing');
    const { index } = await insertItem(generation.id, Number(target.after), instruction);
    return { kind: 'edit', content: `Added ${kind.noun} ${index + 1}.`, data: { ...base, index } };
  }
  if (target.index !== undefined && target.index !== null) {
    const index = Number(target.index);
    if (!items[index]) throw new Error(`There is no ${kind.noun} ${index + 1}.`);
    onPhase('editing');
    await editItem(generation.id, index, instruction);
    return { kind: 'edit', content: `Updated ${kind.noun} ${index + 1}.`, data: { ...base, index } };
  }
  onPhase('planning');
  const plan = await planAgent(generation, instruction);
  return { kind: 'agent_plan', content: plan.summary || '', data: { ...base, steps: plan.steps } };
}

// ── Skills ──

const SKILL_REQUESTS = {
  deck: 'Make a slide deck from this',
  doc: 'Make a training document from this',
};

/** POST { request? }: a skill chip was pressed. Starts planning a deck/document from the conversation. */
async function runSkill(req, res) {
  const type = req.params.skill;
  if (!SKILLS.includes(type)) throw new AppError('Unknown skill', 404);
  const conversation = await getConversationDb(req.params.id);
  const request = String(req.body?.request || '').trim();
  const previous = await listMessagesDb(conversation.id);

  const reply = await startPlanning(conversation, previous, type, request);
  const userMessage = await insertMessageDb(conversation.id, { role: 'user', content: request || SKILL_REQUESTS[type], data: { skill: type } });
  if (conversation.title === 'New chat' && request) await updateConversationDb(conversation.id, { title: titleFrom(request) });
  const assistantMessage = await insertMessageDb(conversation.id, { role: 'assistant', ...reply });
  res.status(201).json(responseFactory.createJsonResponse({ messages: [userMessage, assistantMessage] }));
}

// ── Planning a deck/document: the interview, then the plan ──

/** The planning interview in progress: the latest question or summary, if still active. */
function activeInterview(messages) {
  const last = messages.findLast((m) => m.role === 'assistant' && (m.kind === 'interview' || m.kind === 'brief'));
  return last?.data?.interview?.active ? last : null;
}

async function closeInterview(message) {
  if (message) await updateMessageDataDb(message.id, { interview: { ...message.data.interview, active: false } });
}

/** A deck/document was asked for: the planning interview starts (any earlier one is dropped). */
async function startPlanning(conversation, previous, type, request) {
  await closeInterview(activeInterview(previous));
  return startInterview({ type, request, previous, docIds: conversation.doc_ids });
}

/** The current interview message of this conversation, or a 409. */
async function currentInterview(conversation, kinds = ['interview', 'brief']) {
  const message = activeInterview(await listMessagesDb(conversation.id));
  if (!message || !kinds.includes(message.kind)) throw new AppError('No plan is being prepared here', 409);
  return message;
}

async function replyWith(res, conversation, previousMessage, reply) {
  await closeInterview(previousMessage);
  const message = await insertMessageDb(conversation.id, { role: 'assistant', ...reply });
  res.json(responseFactory.createJsonResponse({ messages: [message] }));
}

/** "Just make it": fills in the questions not answered yet and shows the summary. */
async function skipInterview(req, res) {
  const conversation = await getConversationDb(req.params.id);
  const message = await currentInterview(conversation, ['interview']);
  await replyWith(res, conversation, message, skipRest(message.data.interview));
}

/** Change one answer from the summary: that question is asked again. */
async function changeInterview(req, res) {
  const conversation = await getConversationDb(req.params.id);
  const message = await currentInterview(conversation);
  await replyWith(res, conversation, message, reask(message.data.interview, String(req.body?.slot || '')));
}

async function cancelInterview(req, res) {
  const conversation = await getConversationDb(req.params.id);
  const message = await currentInterview(conversation);
  await replyWith(res, conversation, message, { kind: 'text', content: 'Okay, I won\'t make it. Ask again any time.' });
}

/** The summary was confirmed: the outline is planned (the plan card follows the job). */
async function planFromInterview(req, res) {
  const conversation = await getConversationDb(req.params.id);
  const message = await currentInterview(conversation, ['brief']);
  const state = message.data.interview;
  const brief = await briefFromInterview(state, conversation.doc_ids);
  if (!conversation.doc_ids?.length && !brief.source_text) {
    throw new AppError('Choose the documents to work with first (📎 Documents).', 400);
  }
  const generation = await createPlan({
    type: state.type, brief, documentIds: conversation.doc_ids, conversationId: conversation.id, ownerId: conversation.owner_id,
  });
  await replyWith(res, conversation, message, { kind: 'generation', data: { generation_id: generation.id, type: state.type } });
}

// ── Deck-wide changes proposed in the chat ──

/** POST { steps }: applies the steps the user kept, as a background job (poll the generation to watch). */
async function applyPlan(req, res) {
  const message = await getMessageDb(req.params.id, req.params.messageId);
  if (message.kind !== 'agent_plan') throw new AppError('Nothing to apply', 400);
  const steps = Array.isArray(req.body?.steps) ? req.body.steps : [];
  if (!steps.length) throw new AppError('Keep at least one step', 400);
  const generationId = message.data.generation_id;
  const started = await startJob(generationId, 'agent', async () => {
    await applyAgent(generationId, steps);
    return {};
  });
  if (!started) throw new AppError('Still working on a previous change. Try again when it finishes.', 409);
  const updated = await updateMessageDataDb(message.id, { applied: true, steps });
  res.json(responseFactory.createJsonResponse({ message: updated }));
}

async function undoPlan(req, res) {
  const message = await getMessageDb(req.params.id, req.params.messageId);
  if (message.kind !== 'agent_plan' || !message.data.applied) throw new AppError('Nothing to undo', 400);
  const generation = await getGenerationByIdDb(message.data.generation_id);
  if (isJobLive(generation.job)) throw new AppError('Still applying. Try again when it finishes.', 409);
  await undoAgent(generation.id);
  res.json(responseFactory.createJsonResponse({ message: await updateMessageDataDb(message.id, { undone: true }) }));
}

export default {
  listConversations, getConversation, createConversation, updateConversation, deleteConversation,
  sendMessage, runSkill, applyPlan, undoPlan,
  skipInterview, changeInterview, cancelInterview, planFromInterview,
};
