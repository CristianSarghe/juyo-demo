import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';

const bundle = fileURLToPath(new URL('../dist/worker/worker.js', import.meta.url));
test(
  'actual workerd provisions the compute class and preserves auth/CORS without SQL or storage access',
  {
    skip: !existsSync(bundle),
    timeout: 30_000,
  },
  async () => {
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        scriptPath: bundle,
        compatibilityDate: '2026-11-14',
        compatibilityFlags: ['nodejs_compat'],
        durableObjects: { SQL_GATEWAY: { className: 'JuyoSqlGateway', useSQLite: true } },
        bindings: {
          SQL_SERVER: 'unused.example.invalid',
          SQL_DATABASE: 'unused',
          SQL_USER: 'unused',
          SQL_PASSWORD: 'not-a-real-secret',
          ALLOWED_ORIGINS:
            'http://127.0.0.1:4200,http://localhost:4200,http://127.0.0.1:4201,http://localhost:4201',
        },
        log: new Log(LogLevel.ERROR),
      }),
    );
    try {
      const request = (path: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        if (!headers.has('Origin')) headers.set('Origin', 'http://127.0.0.1:4200');
        return runtime.dispatchFetch(`https://hotel.example.invalid${path}`, {
          ...init,
          headers,
        });
      };
      assert.equal((await request('/health')).status, 200);
      const unauthenticated = await request('/api/v1/sessions/current');
      assert.equal(unauthenticated.status, 401);
      assert.equal(
        unauthenticated.headers.get('Access-Control-Allow-Origin'),
        'http://127.0.0.1:4200',
      );
      assert.equal(((await unauthenticated.json()) as any).code, 'UNAUTHENTICATED');
      assert.equal((await request('/api/v1/hotels', { method: 'OPTIONS' })).status, 204);
      for (const origin of ['http://127.0.0.1:4201', 'http://localhost:4201']) {
        const preflight = await request('/api/v1/hotels', {
          method: 'OPTIONS',
          headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' },
        });
        assert.equal(preflight.status, 204, `${origin} preflight`);
        assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
      }
      assert.equal(
        (
          await request('/api/v1/hotels', {
            headers: { Origin: 'https://untrusted.example.invalid' },
          })
        ).status,
        403,
      );
      const invalid = await request('/api/v1/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'unknown@example.invalid', password: 'not-a-real-password' }),
      });
      assert.equal(
        invalid.status,
        401,
        'Invalid credentials are rejected in the compute class without opening SQL.',
      );
      const namespace = await runtime.getDurableObjectNamespace('SQL_GATEWAY');
      const direct = await namespace
        .get(namespace.idFromName('juyo-network'))
        .fetch('https://hotel.example.invalid/health');
      assert.equal(direct.status, 200);
    } finally {
      await runtime.dispose();
    }
  },
);
