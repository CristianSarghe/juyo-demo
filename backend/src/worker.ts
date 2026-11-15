import { handleApi } from './app';
import { readEnvironment, type ApiEnvironment } from './config';
import { createDatabase, runInferenceWithoutSql } from './database';
import { SessionRepository } from './auth';
import { SqlNetworkRepository } from './data/sql-network.repository';
import { SqlWorkspaceRepository } from './persistence/sql-workspace.repository';
import type { HotelNetwork } from './domain/network.models';
import { searchRobotsResponse, withSearchExclusion } from './search-indexing';

// Only plain decoded data is shared. TCP pools never cross Worker requests.
let snapshot: { value: HotelNetwork; expires: number } | undefined;

interface SqlGatewayNamespace {
  getByName(name: string): { fetch(request: Request): Promise<Response> };
}
interface WorkerEnvironment extends ApiEnvironment {
  SQL_GATEWAY?: SqlGatewayNamespace;
}

function isHealthRequest(request: Request): boolean {
  return new URL(request.url).pathname === '/health' && request.method === 'GET';
}
function health(): Response {
  return Response.json(
    { status: 'ok', service: 'juyo-api' },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

function serviceUnavailable(): Response {
  return Response.json(
    {
      type: 'about:blank',
      title: 'Service unavailable',
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      detail: 'The API is temporarily unavailable. Please retry.',
    },
    {
      status: 503,
      headers: { 'Content-Type': 'application/problem+json', 'Cache-Control': 'no-store' },
    },
  );
}

/** SQL/TLS work runs here, inside the compute-only object when its binding exists. */
async function handleSqlRequest(request: Request, bindings: ApiEnvironment): Promise<Response> {
  let database: ReturnType<typeof createDatabase> | undefined;
  try {
    const env = readEnvironment(bindings as unknown as NodeJS.ProcessEnv);
    database = createDatabase(env, true);
    const requestDatabase = database;
    const pool = database.pool;
    const network = new SqlNetworkRepository(pool);
    return await handleApi(request, {
      env,
      sessions: new SessionRepository(pool, database.connect),
      workspace: new SqlWorkspaceRepository(pool),
      runInference: (infer) => runInferenceWithoutSql(requestDatabase, infer),
      loadReference: () => network.loadReference(),
      readCollection: (key, params) => network.readCollection(key, params),
      loadWarningsData: (params) => network.loadWarningsData(params),
      loadUpcomingEventsData: (params) => network.loadUpcomingEventsData(params),
      loadPriceHistoryData: (roomTypeId, params) =>
        network.loadPriceHistoryData(roomTypeId, params),
      loadNetwork: async () => {
        if (snapshot && snapshot.expires > Date.now()) return snapshot.value;
        const value = await network.load();
        snapshot = { value, expires: Date.now() + 30_000 };
        return value;
      },
    });
  } catch {
    return serviceUnavailable();
  } finally {
    await database?.close().catch(() => undefined);
  }
}

/**
 * Free Durable Objects allow the SQL driver's CPU work beyond the edge's 10 ms.
 * The namespace has Cloudflare's required SQLite backend, but this class never
 * reads or writes its storage. Hotel data and every durable change stay in SQL Server.
 */
export class JuyoSqlGateway {
  constructor(
    _state: unknown,
    private readonly env: ApiEnvironment,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const response =
      searchRobotsResponse(request) ??
      (isHealthRequest(request) ? health() : await handleSqlRequest(request, this.env));
    return withSearchExclusion(response);
  }
}

export default {
  async fetch(request: Request, bindings: WorkerEnvironment): Promise<Response> {
    try {
      const robots = searchRobotsResponse(request);
      if (robots) return robots;
      if (isHealthRequest(request)) return withSearchExclusion(health());
      const response = bindings.SQL_GATEWAY
        ? await bindings.SQL_GATEWAY.getByName('juyo-network').fetch(request)
        : // Preserve the independently removable direct local/transition handler.
          await handleSqlRequest(request, bindings);
      return withSearchExclusion(response);
    } catch {
      // A namespace/transport failure also needs a public noindex response,
      // without exposing driver details or losing the normal problem envelope.
      return withSearchExclusion(serviceUnavailable());
    }
  },
};
