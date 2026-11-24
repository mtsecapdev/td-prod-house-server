// Creates the first admin account (or another admin) from the command line, so there is never a default
// password: npm run create-admin -- <username> ["Display name"]
// Prints a temporary password, which must be changed at the first sign-in.
import pool from '../db/pool.js';
import { hashPassword, temporaryPassword } from '../services/auth.js';
import { insertUserDb } from '../db/usersQueries.js';

const [username, displayName = ''] = process.argv.slice(2);
if (!username) {
  console.error('Usage: npm run create-admin -- <username> ["Display name"]');
  process.exit(1);
}
try {
  const password = temporaryPassword();
  const user = await insertUserDb({ username, displayName, passwordHash: await hashPassword(password), role: 'admin' });
  console.log(`Admin "${user.username}" created.`);
  console.log(`Temporary password: ${password}`);
  console.log('Sign in with it; you will be asked to choose your own password.');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
