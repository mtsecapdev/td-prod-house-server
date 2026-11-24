// Admin: managing accounts. There is no self sign-up; an admin creates each account with a temporary password
// that the person must change when they first sign in.
import responseFactory from '../utils/responseFactory.js';
import AppError from '../utils/AppError.js';
import { hashPassword, temporaryPassword, endOtherSessions } from '../services/auth.js';
import { listUsersDb, insertUserDb, updateUserDb, setPasswordDb, getUserDb, countActiveAdminsDb } from '../db/usersQueries.js';

const ok = (res, data) => res.json(responseFactory.createJsonResponse(data));
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,39}$/i;

async function listUsers(req, res) {
  ok(res, { users: await listUsersDb() });
}

/** Creates an account. The temporary password is returned once, for the admin to hand over. */
async function createUser(req, res) {
  const username = String(req.body?.username || '').trim();
  const displayName = String(req.body?.displayName || '').trim();
  const role = req.body?.role === 'admin' ? 'admin' : 'user';
  if (!USERNAME_RE.test(username)) {
    throw new AppError('Usernames are 2-40 letters, digits, dots, dashes or underscores, starting with a letter or digit', 400);
  }
  const password = temporaryPassword();
  const user = await insertUserDb({ username, displayName, passwordHash: await hashPassword(password), role });
  ok(res, { user, temporaryPassword: password });
}

/** Changes a user's name, role or disabled state. An admin can't lock themselves (or the last admin) out. */
async function updateUser(req, res) {
  const id = Number(req.params.id);
  const { displayName, role, disabled } = req.body || {};
  const target = await getUserDb(id);
  const losesAdmin = target.role === 'admin' && !target.disabled && ((role && role !== 'admin') || disabled === true);
  if (losesAdmin && id === req.user.id) throw new AppError('You can\'t remove your own admin access or disable yourself', 400);
  if (losesAdmin && (await countActiveAdminsDb()) <= 1) throw new AppError('There must be at least one active admin', 400);
  const user = await updateUserDb(id, {
    displayName: typeof displayName === 'string' ? displayName.trim() : undefined,
    role: role === 'admin' || role === 'user' ? role : undefined,
    disabled: typeof disabled === 'boolean' ? disabled : undefined,
  });
  if (disabled === true) await endOtherSessions(id);
  ok(res, { user });
}

/** Sets a new temporary password (returned once) and signs the user out everywhere. */
async function resetPassword(req, res) {
  const id = Number(req.params.id);
  await getUserDb(id);
  const password = temporaryPassword();
  await setPasswordDb(id, await hashPassword(password), { mustChange: true });
  await endOtherSessions(id);
  ok(res, { user: await getUserDb(id), temporaryPassword: password });
}

export default { listUsers, createUser, updateUser, resetPassword };
