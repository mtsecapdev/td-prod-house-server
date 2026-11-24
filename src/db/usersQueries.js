import pool from './pool.js';
import AppError from '../utils/AppError.js';

const PUBLIC = 'id, username, display_name, role, must_change_password, disabled, last_login_at, created_at';

export async function listUsersDb() {
  return (await pool.query(`SELECT ${PUBLIC} FROM users ORDER BY lower(username)`)).rows;
}

export async function getUserDb(id) {
  const res = await pool.query(`SELECT ${PUBLIC} FROM users WHERE id = $1`, [id]);
  if (!res.rowCount) throw new AppError('User not found', 404);
  return res.rows[0];
}

export async function insertUserDb({ username, displayName, passwordHash, role = 'user' }) {
  try {
    const res = await pool.query(
      `INSERT INTO users (username, display_name, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING ${PUBLIC}`,
      [username, displayName, passwordHash, role],
    );
    return res.rows[0];
  } catch (err) {
    if (err.code === '23505') throw new AppError(`The username "${username}" is taken`, 409, err);
    throw err;
  }
}

/** Updates display name, role or disabled. */
export async function updateUserDb(id, { displayName, role, disabled }) {
  const res = await pool.query(
    `UPDATE users SET display_name = COALESCE($2, display_name), role = COALESCE($3, role), disabled = COALESCE($4, disabled)
     WHERE id = $1 RETURNING ${PUBLIC}`,
    [id, displayName ?? null, role ?? null, disabled ?? null],
  );
  if (!res.rowCount) throw new AppError('User not found', 404);
  return res.rows[0];
}

export async function setPasswordDb(id, passwordHash, { mustChange }) {
  await pool.query(
    'UPDATE users SET password_hash = $2, must_change_password = $3, failed_logins = 0, locked_until = NULL WHERE id = $1',
    [id, passwordHash, mustChange],
  );
}

export async function getPasswordHashDb(id) {
  return (await pool.query('SELECT password_hash FROM users WHERE id = $1', [id])).rows[0]?.password_hash;
}

export async function countActiveAdminsDb() {
  return (await pool.query("SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND NOT disabled")).rows[0].n;
}
