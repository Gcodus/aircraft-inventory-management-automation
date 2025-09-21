import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

async function run() {
  const [row] = await sql`SELECT version()`;
  console.log('✅ Connected to:', row.version);
}

run().catch(err => {
  console.error('❌ DB connection error:', err.message);
});
