import { connect as connectTls, type TLSSocket } from 'node:tls';
import type { Socket } from 'node:net';

interface TediousTlsConnection {
  wrapWithTls(socket: Socket, signal: AbortSignal): Promise<TLSSocket>;
}

/** Encrypted SQL packets must remain below the TLS record limit. */
export const WORKER_SQL_PACKET_SIZE = 16_000;

/**
 * Isolated adapter for pinned mssql 12.7.14 / Tedious 20.3.9 on Workers.
 * SQL Server 2022 accepts TDS 8 over directly established TLS without ALPN.
 * Workers cannot wrap a previously opened net.Socket or accept ALPN options.
 * Certificate and hostname validation remain enabled by node:tls defaults.
 * Pair this adapter with encrypt:'strict' and WORKER_SQL_PACKET_SIZE. Large Unicode
 * parameters are staged in bounded pieces by the persistence adapter.
 */
export function createWorkerSqlTransport(server: string, port = 1433, timeoutMs = 15_000) {
  const connector = (...arguments_: unknown[]): Promise<Socket> => {
    // Tedious supplies connect options, DNS lookup and its cancellation signal.
    const signal = arguments_[2] instanceof AbortSignal ? arguments_[2] : undefined;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const socket = connectTls({ host: server, port, servername: server });
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeListener('error', fail);
        socket.removeListener('secureConnect', connected);
        signal?.removeEventListener('abort', aborted);
      };
      const fail = (error: unknown) => {
        cleanup();
        socket.destroy();
        reject(error);
      };
      const aborted = () => fail(signal?.reason ?? new Error('SQL connection cancelled.'));
      const connected = () => {
        if (socket.authorized !== true) {
          fail(new Error('The SQL Server TLS certificate could not be verified.'));
          return;
        }
        cleanup();
        resolve(socket);
      };
      const timer = setTimeout(() => fail(new Error('SQL TLS connection timed out.')), timeoutMs);
      socket.once('error', fail);
      socket.once('secureConnect', connected);
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  };

  const beforeConnect = (connection: TediousTlsConnection): void => {
    // The public connector already supplies a verified TLS socket. Keep TDS 8
    // framing, but prevent Tedious from wrapping that socket a second time.
    connection.wrapWithTls = async (socket: Socket, signal: AbortSignal) => {
      signal.throwIfAborted();
      const secureSocket = socket as TLSSocket;
      if (secureSocket.encrypted !== true || secureSocket.authorized !== true) {
        socket.destroy();
        throw new Error('A verified TLS connection is required for SQL Server.');
      }
      return secureSocket;
    };
  };

  return { connector, beforeConnect };
}
