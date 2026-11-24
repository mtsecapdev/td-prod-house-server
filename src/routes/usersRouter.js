import { Router } from 'express';
import usersController from '../controllers/usersController.js';
import { requireAdmin } from '../middleware/auth.js';

// Admin only.
const usersRouter = Router();
usersRouter.use(requireAdmin);

usersRouter.get('/', usersController.listUsers);
usersRouter.post('/', usersController.createUser);
usersRouter.patch('/:id', usersController.updateUser);
usersRouter.post('/:id/reset-password', usersController.resetPassword);

export default usersRouter;
