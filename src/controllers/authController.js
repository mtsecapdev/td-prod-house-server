// Signing in and out, and the signed-in user's own account. Admin user management is in usersController.js.
import responseFactory from '../utils/responseFactory.js';
import AppError from '../utils/AppError.js';
import config from '../config.js';
import {
  SESSION_COOKIE, authenticate, createSession, endSession, endOtherSessions, hashPassword, verifyPassword, passwordProblem,
} from '../services/auth.js';
import { getPasswordHashDb, setPasswordDb, getUserDb } from '../db/usersQueries.js';

const ok = (res, data) => res.json(responseFactory.createJsonResponse(data));

function setSessionCookie(res, token, expires) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, // not readable by page scripts
    sameSite: 'strict',
    secure: config.secureCookies, // https only, on a server behind TLS
    path: '/',
    expires,
  });
}

function publicUser(u) {
  return { id: u.id, username: u.username, display_name: u.display_name, role: u.role, must_change_password: u.must_change_password };
}

async function login(req, res) {
  const { username, password } = req.body || {};
  const user = await authenticate(username, password);
  const { token, expires } = await createSession(user.id);
  setSessionCookie(res, token, expires);
  ok(res, { user: publicUser(user) });
}

async function logout(req, res) {
  await endSession(req.sessionToken);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  ok(res, { signedOut: true });
}

/** The signed-in user, or null (the client shows the sign-in page). */
async function me(req, res) {
  ok(res, { user: req.user ? publicUser(req.user) : null });
}

/** Changes the signed-in user's own password; ends their other sessions. */
async function changePassword(req, res) {
  if (!req.user) throw new AppError('Please sign in', 401);
  const { currentPassword, newPassword } = req.body || {};
  if (!(await verifyPassword(String(currentPassword || ''), await getPasswordHashDb(req.user.id)))) {
    throw new AppError('Your current password is wrong', 400);
  }
  const problem = passwordProblem(newPassword, { username: req.user.username });
  if (problem) throw new AppError(problem, 400);
  if (newPassword === currentPassword) throw new AppError('Choose a password different from the current one', 400);
  await setPasswordDb(req.user.id, await hashPassword(newPassword), { mustChange: false });
  await endOtherSessions(req.user.id, req.sessionToken);
  ok(res, { user: publicUser(await getUserDb(req.user.id)) });
}

export default { login, logout, me, changePassword };
