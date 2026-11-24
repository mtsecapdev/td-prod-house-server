import { Router } from 'express';
import authController from '../controllers/authController.js';

const authRouter = Router();

authRouter.post('/login', authController.login);
authRouter.post('/logout', authController.logout);
authRouter.get('/me', authController.me);
authRouter.post('/password', authController.changePassword);

export default authRouter;
