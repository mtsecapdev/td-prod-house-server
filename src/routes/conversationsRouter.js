import { Router } from 'express';
import conversationsController from '../controllers/conversationsController.js';

const conversationsRouter = Router();

conversationsRouter.get('/', conversationsController.listConversations);
conversationsRouter.post('/', conversationsController.createConversation);
conversationsRouter.get('/:id', conversationsController.getConversation);
conversationsRouter.patch('/:id', conversationsController.updateConversation);
conversationsRouter.delete('/:id', conversationsController.deleteConversation);

// Ask a question, or change the deck/document the message targets (streamed).
conversationsRouter.post('/:id/messages', conversationsController.sendMessage);
// Make a deck or training document from the conversation: { request? }
conversationsRouter.post('/:id/skills/:skill', conversationsController.runSkill);
// Deck-wide changes proposed in the chat
conversationsRouter.post('/:id/messages/:messageId/apply', conversationsController.applyPlan);
conversationsRouter.post('/:id/messages/:messageId/undo', conversationsController.undoPlan);

export default conversationsRouter;
