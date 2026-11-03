import { Pool } from 'pg';
import pgvector from 'pgvector/pg';
import config from '../config.js';

export default new Pool({
  connectionString: config.databaseUrl,
  onConnect: async (client) => await pgvector.registerTypes(client),
});
