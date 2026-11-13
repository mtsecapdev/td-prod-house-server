import { Router } from 'express';
import {
  listConversationsDb,
  getConversationDb,
  createConversationDb,
  updateConversationDb,
  deleteConversationDb,
} from '../db/conversationsQueries.js';
import responseFactory from '../utils/responseFactory.js';

const conversationsRouter = Router();

conversationsRouter.get('/', async (req, res) => {
  const conversations = await listConversationsDb();
  res.json(responseFactory.createJsonResponse({ conversations }));
});

conversationsRouter.get('/:id', async (req, res) => {
  const conversation = await getConversationDb(req.params.id);
  res.json(responseFactory.createJsonResponse({ conversation }));
});

conversationsRouter.post('/', async (req, res) => {
  const { title, docIds } = req.body;
  const conversation = await createConversationDb(title || 'New chat', docIds || []);
  res.json(responseFactory.createJsonResponse({ conversation }));
});

conversationsRouter.put('/:id', async (req, res) => {
  const { title, messages, docIds } = req.body;
  const conversation = await updateConversationDb(req.params.id, { title, messages, docIds });
  res.json(responseFactory.createJsonResponse({ conversation }));
});

conversationsRouter.delete('/:id', async (req, res) => {
  await deleteConversationDb(req.params.id);
  res.json(responseFactory.createJsonResponse({ deleted: true }));
});

export default conversationsRouter;
