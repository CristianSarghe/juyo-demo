import { readFile } from 'node:fs/promises';
import { createDatabase } from '../src/database';
import { readEnvironment } from '../src/config';
import { SessionRepository } from '../src/auth';

async function main() {
  const database = createDatabase(readEnvironment());
  try {
    const pool = await database.connect();
    for (const file of ['001_api.sql', '002_demo_accounts.sql']) {
      await pool
        .request()
        .batch(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
    }
    await new SessionRepository(pool).provisionDemoAccounts();
    console.log(
      'API schema migrations and demo identities are ready; canonical hotel tables unchanged.',
    );
  } finally {
    await database.close();
  }
}
main().catch((error: unknown) => {
  const details =
    error && typeof error === 'object'
      ? (error as { number?: number; lineNumber?: number; code?: string })
      : {};
  console.error('API schema setup failed.', {
    number: details.number,
    line: details.lineNumber,
    code: details.code,
  });
  process.exitCode = 1;
});
