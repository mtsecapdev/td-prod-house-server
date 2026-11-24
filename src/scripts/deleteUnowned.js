// Deletes everything that has no owner: the documents, chats, decks/documents/images and Library copies from
// before accounts (they are visible to nobody), with their files.
//   npm run delete-unowned            lists what would be deleted
//   npm run delete-unowned -- --yes   deletes it
import { unlink } from 'node:fs/promises';
import pool from '../db/pool.js';
import { deleteFigureFiles } from '../services/figures.js';
import { deleteDiagrams } from '../services/diagrams.js';
import { getImagePathsDb } from '../db/generationsQueries.js';

const confirmed = process.argv.includes('--yes');
const removeFile = (path) => (path ? unlink(path).catch(() => {}) : Promise.resolve());

try {
  const docs = (await pool.query('SELECT id, name, file_path FROM documents WHERE owner_id IS NULL ORDER BY id')).rows;
  const chats = (await pool.query('SELECT id, title FROM conversations WHERE owner_id IS NULL ORDER BY id')).rows;
  const gens = (await pool.query('SELECT id, type FROM generations WHERE owner_id IS NULL ORDER BY id')).rows;
  const assets = (await pool.query('SELECT id, title, file_path FROM assets WHERE owner_id IS NULL ORDER BY id')).rows;

  console.log(`Documents (${docs.length}): ${docs.map((d) => d.name).join(', ') || '-'}`);
  console.log(`Chats (${chats.length}): ${chats.map((c) => c.title).join(', ') || '-'}`);
  console.log(`Decks, documents and images (${gens.length})`);
  console.log(`Library copies (${assets.length})`);

  if (!confirmed) {
    console.log('\nNothing deleted. Run again with --yes to delete all of the above.');
  } else {
    const genIds = gens.map((g) => g.id);
    const imageFiles = (await getImagePathsDb(genIds)).map((r) => r.file_path);
    // One transaction, on one connection: all of it is deleted, or none.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM assets WHERE owner_id IS NULL');
      await client.query('DELETE FROM generations WHERE owner_id IS NULL');
      await client.query('DELETE FROM conversations WHERE owner_id IS NULL'); // messages go with them
      await client.query('DELETE FROM documents WHERE owner_id IS NULL'); // passages and figure rows go with them
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    await Promise.all(assets.map((a) => removeFile(a.file_path)));
    await Promise.all(imageFiles.map((p) => removeFile(p)));
    await Promise.all(genIds.map((id) => deleteDiagrams(id).catch(() => {})));
    for (const d of docs) {
      await deleteFigureFiles(d.id).catch(() => {});
      // An uploaded file is shared by everyone who uploaded the same file: keep it while a document uses it.
      const stillUsed = (await pool.query('SELECT 1 FROM documents WHERE file_path = $1 LIMIT 1', [d.file_path])).rowCount;
      if (!stillUsed) await removeFile(d.file_path);
    }
    console.log('\nDeleted.');
  }
} catch (err) {
  console.error(`Failed, nothing deleted from the database: ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
