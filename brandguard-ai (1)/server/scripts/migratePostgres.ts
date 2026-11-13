import dotenv from 'dotenv';
import { createPostgresAdapter } from '../db/postgresAdapter.js';

dotenv.config();

async function main() {
  const databaseUrl = (process.env.DATABASE_URL || '').trim();
  if (!databaseUrl) {
    console.error('Error: DATABASE_URL environment variable is required to run PostgreSQL migrations.');
    process.exit(1);
  }

  const adapter = await createPostgresAdapter({
    connectionString: databaseUrl,
    runMigrations: true,
  });

  const applied = await adapter.query('SELECT id, name, applied_at FROM schema_migrations ORDER BY id ASC');
  console.log('PostgreSQL migrations complete. Applied migrations:');
  for (const row of applied.rows) {
    console.log(`  - ${row.id} (${row.name}) @ ${new Date(row.applied_at).toISOString()}`);
  }

  await adapter.close();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
