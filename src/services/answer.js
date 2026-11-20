// Answers a question from the conversation's documents (retrieval-augmented), as the chat does.
import config from '../config.js';
import { generateAnswer, generateGeneralAnswer, requestEmbedding, rewriteQuery } from './llm.js';
import { getSimilarChunksDb, getNeighborChunksDb } from '../db/chunksQueries.js';
import { figuresInChunks, figuresMentioned, stripFigureMarkers } from './figures.js';

const EXPAND_THRESHOLD = 0.6;
// Below this best-match score nothing in the documents is close, so the model answers from general knowledge
// without reading excerpts. Calibrated on 21 questions over three documents: answerable ones scored 0.38-0.79,
// unrelated ones (a cake recipe, Python, "hi") 0.26-0.33. Loosely worded real questions score close to unrelated
// ones ("How did the defence business do?" 0.38, a running question 0.37), so the line stays low: it never
// skipped an answerable question in the test, and caught 6 of 7 unrelated ones.
const RELEVANCE_MIN = 0.35;
// Passages remembered with an answer: a deck made later in the conversation starts from them.
const SOURCES_KEPT = 8;

/**
 * @param {{ question: string, history: {role, content}[], docIds: number[], onPhase?: (phase) => void }} input
 * @returns {Promise<{ content: string, grounded: boolean, figures: object[], sourceIds: number[] }>}
 */
export async function answerQuestion({ question, history, docIds, onPhase = () => {} }) {
  onPhase('rewriting');
  const searchQuery = await rewriteQuery(history, question);

  onPhase('searching');
  const topChunks = await getSimilarChunksDb(await requestEmbedding(searchQuery), config.rag.topK, docIds, searchQuery);
  const best = Math.max(0, ...topChunks.map((c) => c.similarity));
  if (best < RELEVANCE_MIN) {
    onPhase('generating');
    const reply = await generateGeneralAnswer(question, history);
    return { content: reply.content, grounded: false, figures: [], sourceIds: [] };
  }
  // Strong matches bring their neighbours, so an answer sees the whole passage around a hit.
  const seen = new Set(topChunks.map((c) => c.id));
  const expanded = [...topChunks];
  for (const chunk of topChunks) {
    if (chunk.level !== 'leaf' || chunk.similarity < EXPAND_THRESHOLD) continue;
    for (const n of await getNeighborChunksDb(chunk.id, chunk.document_id, 3)) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      expanded.push({ ...n, similarity: chunk.similarity * 0.9 });
    }
  }
  expanded.sort((a, b) => b.similarity - a.similarity);
  const finalChunks = expanded.slice(0, config.rag.topK + 5);

  onPhase('generating');
  const available = await figuresInChunks(finalChunks);
  // The rewrite is only for retrieval. Answer what the user actually asked; history supplies the context.
  const { llmResponse, grounded } = await generateAnswer(
    question,
    history,
    finalChunks.map((c) => ({ ...c, content: stripFigureMarkers(c.content) })),
    available,
  );
  // Figures shown under the answer: only those it refers to.
  const figures = figuresMentioned(available, llmResponse.content).map((f) => ({
    id: f.id, caption: f.caption, page: f.page, width: f.width, height: f.height, document_id: f.document_id,
  }));
  const sourceIds = finalChunks.filter((c) => c.level === 'leaf' || !c.level).slice(0, SOURCES_KEPT).map((c) => c.id);
  return { content: llmResponse.content, grounded, figures, sourceIds };
}
