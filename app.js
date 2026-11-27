import express from 'express';
import { fileURLToPath } from 'node:url';
import config from './src/config.js';
import responseFactory from './src/utils/responseFactory.js';
import documentsRouter from './src/routes/documentsRouter.js';
import generationsRouter from './src/routes/generationsRouter.js';
import assetsRouter from './src/routes/assetsRouter.js';
import conversationsRouter from './src/routes/conversationsRouter.js';
import figuresRouter from './src/routes/figuresRouter.js';
import { requestLogger } from './src/middleware/requestLogger.js';
import { loadUser, requireUser } from './src/middleware/auth.js';
import authRouter from './src/routes/authRouter.js';
import usersRouter from './src/routes/usersRouter.js';
import { startImportWorker } from './src/services/imports.js';

const app = express();

// MIDDLEWARE
// No CORS: the client reaches the API on its own origin (/api, forwarded by Vite in development and by the web
// server in production), so the session cookie can be SameSite=Strict.
app.use(express.json());
app.use(requestLogger);
app.use(loadUser);

// ROUTES
// The slide design spec, layout engine and icons, shared with the editor's preview (no user data).
app.use('/shared', express.static(fileURLToPath(new URL('./shared', import.meta.url))));
app.use('/auth', authRouter); // signing in, out, and changing one's own password
// Everything else needs a signed-in user whose password is not a temporary one.
app.use(requireUser);
app.use('/users', usersRouter); // admin only
app.use('/documents', documentsRouter);
app.use('/generations', generationsRouter);
app.use('/assets', assetsRouter);
app.use('/conversations', conversationsRouter);
app.use('/figures', figuresRouter);

// ERROR HANDLER
app.use((err, req, res, next) => {
  // Immediate server log
  console.error(err);

  // Prepare the response parameters
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal server error';

  res.status(statusCode).json(
    responseFactory.createJsonResponse(
      {
        message,
        statusCode,
      },
      err,
    ),
  );
});

app.listen(config.port, (error) => {
  if (error) throw error;
  console.log(`Listening on ${config.port}`);
  // Document imports run in the background; ones cut off by a restart resume.
  startImportWorker();
});
