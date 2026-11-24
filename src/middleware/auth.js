// Who is signed in, for every request. Everything except signing in needs a session; a user who must change
// their password can reach only the account routes until they do; admin routes need the admin role.
import pool from '../db/pool.js';
import AppError from '../utils/AppError.js';
import { SESSION_COOKIE, userForSession } from '../services/auth.js';

export function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/** Sets req.user (or null) from the session cookie. */
export async function loadUser(req, res, next) {
  req.sessionToken = readCookie(req, SESSION_COOKIE);
  req.user = await userForSession(req.sessionToken);
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) throw new AppError('Please sign in', 401);
  if (req.user.must_change_password) throw new AppError('Choose a new password first', 403);
  next();
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') throw new AppError('Only an admin can do this', 403);
  next();
}

const OWNED_TABLES = new Set(['documents', 'conversations', 'generations', 'assets']);

/**
 * router.param handler: the :id must be a row the signed-in user owns. Anything else is "not found", so ids of
 * other people's work reveal nothing.
 */
export function ownedBy(table, noun) {
  if (!OWNED_TABLES.has(table)) throw new Error(`Not an owned table: ${table}`);
  return async (req, res, next, id) => {
    const res2 = await pool.query(`SELECT owner_id FROM ${table} WHERE id = $1`, [Number(id) || 0]);
    if (!res2.rowCount || res2.rows[0].owner_id !== req.user.id) throw new AppError(`${noun} not found`, 404);
    next();
  };
}

/** The subset of figure ids from the user's own documents. */
export async function ownFigureIds(userId, ids) {
  const list = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
  if (!list.length) return [];
  const res = await pool.query(
    'SELECT f.id FROM figures f JOIN documents d ON d.id = f.document_id WHERE d.owner_id = $1 AND f.id = ANY($2)',
    [userId, list],
  );
  const mine = new Set(res.rows.map((r) => r.id));
  return list.filter((id) => mine.has(id));
}

/** The subset of document ids the user owns (others are dropped silently). */
export async function ownDocumentIds(userId, ids) {
  const list = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
  if (!list.length) return [];
  const res = await pool.query('SELECT id FROM documents WHERE owner_id = $1 AND id = ANY($2)', [userId, list]);
  const mine = new Set(res.rows.map((r) => r.id));
  return list.filter((id) => mine.has(id));
}
