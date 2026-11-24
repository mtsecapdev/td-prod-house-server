// Passwords and sessions, with Node's own crypto (no extra packages: the deployment is air-gapped).
// Passwords: scrypt with a random salt per user. Sessions: a random token in an httpOnly cookie; the database
// keeps only its SHA-256, so several app servers can share sessions and a leaked table opens nothing.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import pool from '../db/pool.js';
import AppError from '../utils/AppError.js';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 64;

export const SESSION_COOKIE = 'tdph_session';
export const SESSION_DAYS = 7;
// Five wrong passwords lock the account for 15 minutes.
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
export const MIN_PASSWORD_LENGTH = 10;

// ── Passwords ──

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEY_LEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(key, expected);
}

/** Why a new password is not acceptable, or null. */
export function passwordProblem(password, { username } = {}) {
  const pw = String(password || '');
  if (pw.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (username && pw.toLowerCase().includes(String(username).toLowerCase())) return 'The password must not contain your username.';
  return null;
}

/** A temporary password an admin hands over: 12 characters, no look-alikes (0/O, 1/l/I). */
export function temporaryPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(12);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

// ── Sessions ──

const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');

export async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await pool.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [tokenHash(token), userId, expires]);
  return { token, expires };
}

/** The signed-in user for a session token, or null. Expired sessions are removed as they are found. */
export async function userForSession(token) {
  if (!token) return null;
  const res = await pool.query(
    `SELECT u.id, u.username, u.display_name, u.role, u.must_change_password, u.disabled, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1`,
    [tokenHash(token)],
  );
  const row = res.rows[0];
  if (!row) return null;
  if (row.disabled || new Date(row.expires_at) < new Date()) {
    await pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(token)]);
    return null;
  }
  const { expires_at: _e, disabled: _d, ...user } = row;
  return user;
}

export async function endSession(token) {
  if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(token)]);
}

/** Signs a user out everywhere (password changed or reset, account disabled), except the session to keep. */
export async function endOtherSessions(userId, keepToken = null) {
  await pool.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [userId, keepToken ? tokenHash(keepToken) : '']);
}

// ── Signing in ──

/**
 * Checks a username and password. Throws a 401 with the same message whether the user is unknown or the password
 * wrong (no hint which usernames exist), and a 423 while the account is locked after repeated failures.
 */
export async function authenticate(username, password) {
  const res = await pool.query('SELECT * FROM users WHERE lower(username) = lower($1)', [String(username || '').trim()]);
  const user = res.rows[0];
  if (!user || user.disabled) {
    // Spend the same time as a real check, so response times don't reveal which usernames exist.
    await verifyPassword(String(password || ''), await DUMMY_HASH);
    throw new AppError('Wrong username or password', 401);
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const minutes = Math.ceil((new Date(user.locked_until) - Date.now()) / 60000);
    throw new AppError(`Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, 423);
  }
  if (!(await verifyPassword(String(password || ''), user.password_hash))) {
    const failed = user.failed_logins + 1;
    await pool.query(
      `UPDATE users SET failed_logins = $2::int,
         locked_until = CASE WHEN $3::boolean THEN NOW() + make_interval(mins => $4::int) END
       WHERE id = $1`,
      // Locking resets the count, so the account gets a fresh five attempts once the lock ends.
      [user.id, failed >= MAX_FAILED_LOGINS ? 0 : failed, failed >= MAX_FAILED_LOGINS, LOCK_MINUTES],
    );
    if (failed >= MAX_FAILED_LOGINS) throw new AppError(`Too many failed attempts. Try again in ${LOCK_MINUTES} minutes.`, 423);
    throw new AppError('Wrong username or password', 401);
  }
  await pool.query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = NOW() WHERE id = $1', [user.id]);
  return user;
}

const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));
