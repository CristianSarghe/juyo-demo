import sql from 'mssql';
import type { ApiEnvironment } from './config';
import { createWorkerSqlTransport, WORKER_SQL_PACKET_SIZE } from './sql-worker-transport';

/** Node owns one process pool; Workers own one pool for each incoming request. */
export function createDatabase(env: ApiEnvironment, worker = false) {
  const transport = worker
    ? createWorkerSqlTransport(env.SQL_SERVER, Number(env.SQL_PORT ?? 1433), 15_000)
    : undefined;
  const config: sql.config = {
    server: env.SQL_SERVER,
    database: env.SQL_DATABASE,
    user: env.SQL_USER,
    password: env.SQL_PASSWORD,
    port: Number(env.SQL_PORT ?? 1433),
    pool: { min: 0, max: worker ? 1 : 4, idleTimeoutMillis: 30_000 },
    connectionTimeout: 15_000,
    requestTimeout: 30_000,
    options: {
      encrypt: worker ? 'strict' : true,
      trustServerCertificate: worker ? false : env.SQL_TRUST_CERTIFICATE === 'true',
      packetSize: worker ? WORKER_SQL_PACKET_SIZE : 4096,
      enableArithAbort: true,
      abortTransactionOnError: true,
      useUTC: true,
      appName: 'Juyo API',
    },
  };
  if (transport) {
    (config.options as unknown as Record<string, unknown>).connector = transport.connector;
    config.beforeConnect = transport.beforeConnect;
  }
  const pool = new sql.ConnectionPool(config);
  // Never log the connection configuration or driver errors containing query values.
  pool.on('error', () => console.error('SQL connection pool error.'));
  let connecting: Promise<sql.ConnectionPool> | undefined;
  return {
    pool,
    connect: () => {
      if (pool.connected) return Promise.resolve(pool);
      if (connecting) return connecting;
      const attempt = pool.connect();
      connecting = attempt;
      // Cache only in-flight connection work. A resolved promise must not hide an explicit close.
      const settled = () => {
        if (connecting === attempt) connecting = undefined;
      };
      void attempt.then(settled, settled);
      return attempt;
    },
    close: async () => {
      // mssql cannot close a pool while its initial connection is still being established.
      await connecting?.catch(() => undefined);
      connecting = undefined;
      await pool.close();
    },
  };
}

/** Use only with a request-owned pool; Node's shared process pool must stay open. */
export async function runInferenceWithoutSql<T>(
  database: { close(): Promise<unknown>; connect(): Promise<unknown> },
  infer: () => Promise<T>,
): Promise<T> {
  await database.close();
  const answer = await infer();
  // Reconnect only after successful inference. No database write is retried here.
  await database.connect();
  return answer;
}
