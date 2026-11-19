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
import { SKILLS, briefFromConversation } from '../services/skills.js';
import { createPlan } from '../services/planning/outlineJob.js';
import { kindOf } from '../services/planning/kinds.js';
import { editItem, insertItem } from '../services/planning/itemOps.js';
import { planAgent, applyAgent, undoAgent } from '../services/planning/agent.js';
import { startJob } from '../services/jobs.js';

const HISTORY_MESSAGES = 10;
const TITLE_CHARS = 60;

const titleFrom = (text) => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > TITLE_CHARS ? `${t.slice(0, TITLE_CHARS - 1)}…` : t || 'New chat';
};

async function listConversations(req, res) {
  res.json(responseFactory.createJsonResponse({ conversations: await listConversationsDb() }));
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
    generation = presentGeneration(await getGenerationByIdDb(generationId));
    kindOf(generation); // decks and documents only
    if (generation.conversation_id) {
      return res.json(responseFactory.createJsonResponse({ conversation: await getConversationDb(generation.conversation_id) }));
    }
    title = title || generation.name;
    documentIds = generation.source_document_ids || [];
  }
  const conversation = await createConversationDb(titleFrom(title || 'New chat'), documentIds);
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
    docIds: Array.isArray(docIds) ? docIds.map(Number).filter(Boolean) : undefined,
  });
  res.json(responseFactory.createJsonResponse({ conversation }));
}

async function deleteConversation(req, res) {
  await deleteConversationDb(req.params.id);
  res.json(responseFactory.createJsonResponse({ deleted: true }));
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

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const keepalive = setInterval(() => res.write(': keepalive\n\n'), 5000);

  const previous = await listMessagesDb(conversation.id);
  const userMessage = await insertMessageDb(conversation.id, {
    role: 'user', content, data: target ? { target: { generation_id: Number(target.generationId), index: target.index, after: target.after } } : {},
  });
  if (conversation.title === 'New chat' && !target) await updateConversationDb(conversation.id, { title: titleFrom(content) });

  let reply;
  try {
    reply = target
      ? await changeGeneration(target, content, (phase) => send({ phase }))
      : await answer(conversation, previous, content, (phase) => send({ phase }));
  } catch (err) {
    reply = { kind: 'error', content: err.message };
  }
  const assistantMessage = await insertMessageDb(conversation.id, { role: 'assistant', ...reply });
  clearInterval(keepalive);
  send({ phase: 'done', messages: [userMessage, assistantMessage] });
  res.end();
}

async function answer(conversation, previous, question, onPhase) {
  if (!conversation.doc_ids?.length) throw new Error('Choose the documents to work with first (📎 Documents).');
  const history = previous
    .filter((m) => m.kind === 'text')
    .slice(-HISTORY_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content }));
  const result = await answerQuestion({ question, history, docIds: conversation.doc_ids, onPhase });
  return {
    kind: 'text',
    content: result.content,
    data: { figures: result.figures, grounded: result.grounded, source_ids: result.sourceIds },
  };
}

async function changeGeneration(target, instruction, onPhase) {
  const generation = await getGenerationByIdDb(target.generationId);
  const kind = kindOf(generation);
  if (isJobLive(generation.job)) throw new Error(`Still working on the ${generation.job.kind}. Ask again when it finishes.`);
  const items = generation.outline?.[kind.listKey] || [];
  const base = { generation_id: generation.id };

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

/** POST { request? }: makes a plan for a deck/document from the conversation; the chat shows it as a card. */
async function runSkill(req, res) {
  const type = req.params.skill;
  if (!SKILLS.includes(type)) throw new AppError('Unknown skill', 404);
  const conversation = await getConversationDb(req.params.id);
  const request = String(req.body?.request || '').trim();
  const previous = await listMessagesDb(conversation.id);

  const brief = await briefFromConversation(previous, type, request);
  if (!conversation.doc_ids?.length && !brief.source_text) {
    throw new AppError('Choose the documents to work with first (📎 Documents).', 400);
  }
  const userMessage = await insertMessageDb(conversation.id, {
    role: 'user', content: request || (type === 'deck' ? 'Make a slide deck from this' : 'Make a training document from this'),
    data: { skill: type },
  });
  if (conversation.title === 'New chat' && request) await updateConversationDb(conversation.id, { title: titleFrom(request) });
  const generation = await createPlan({ type, brief, documentIds: conversation.doc_ids, conversationId: conversation.id });
  const assistantMessage = await insertMessageDb(conversation.id, {
    role: 'assistant', kind: 'generation', data: { generation_id: generation.id, type },
  });
  res.status(201).json(responseFactory.createJsonResponse({ messages: [userMessage, assistantMessage] }));
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
};
