import { serve } from '@hono/node-server';
import { readEnvironment } from './config';
import { createDatabase } from './database';
import { handleApi } from './app';
import { SessionRepository } from './auth';
import { SqlWorkspaceRepository } from './persistence/sql-workspace.repository';
import { SqlNetworkRepository } from './data/sql-network.repository';
import type { HotelNetwork } from './domain/network.models';

const env = readEnvironment(),
  database = createDatabase(env);
let snapshot: { value: HotelNetwork; expires: number } | undefined;
const server = serve({
  hostname: '127.0.0.1',
  port: Number(env.PORT ?? 8788),
  fetch: async (request) => {
    try {
      const network = new SqlNetworkRepository(database.pool);
      return await handleApi(request, {
        env,
        sessions: new SessionRepository(database.pool, database.connect),
        workspace: new SqlWorkspaceRepository(database.pool),
        loadReference: () => network.loadReference(),
        readCollection: (key, params) => network.readCollection(key, params),
        loadWarningsData: (params) => network.loadWarningsData(params),
        loadUpcomingEventsData: (params) => network.loadUpcomingEventsData(params),
        loadPriceHistoryData: (roomTypeId, params) => network.loadPriceHistoryData(roomTypeId, params),
        loadNetwork: async () => {
          if (snapshot && snapshot.expires > Date.now()) return snapshot.value;
          const value = await network.load();
          snapshot = { value, expires: Date.now() + 30_000 };
          return value;
        },
      });
    } catch {
      return Response.json(
        {
          type: 'about:blank',
          title: 'Service unavailable',
          status: 503,
          code: 'SERVICE_UNAVAILABLE',
          detail: 'The API is temporarily unavailable. Please retry.',
        },
        { status: 503 },
      );
    }
  },
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    server.close(() => void database.close().finally(() => process.exit(0)));
  });
console.log(`Juyo API listening on http://127.0.0.1:${env.PORT ?? 8788}`);
