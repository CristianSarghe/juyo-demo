import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseConfigFileTextToJson } from 'typescript';
import { allowedOrigins, type ApiEnvironment } from '../src/config.js';
import { handleKassandra, type KassandraEnvironment } from '../src/kassandra-worker.js';
import { JuyoSqlGateway } from '../src/worker.js';

function configuredOrigins(name: string): string {
  const path = new URL(`../${name}`, import.meta.url);
  const parsed = parseConfigFileTextToJson(path.pathname, readFileSync(path, 'utf8'));
  assert.equal(parsed.error, undefined, `${name} must be valid JSONC.`);
  const value = parsed.config.vars.ALLOWED_ORIGINS;
  assert.equal(typeof value, 'string');
  return value;
}

const production = 'https://juyo-demo.cristiansarghe.com';
const pagesFallback = 'https://juyo-demo.pages.dev';
const approved = [
  'http://127.0.0.1:4200',
  'http://localhost:4200',
  'http://127.0.0.1:4201',
  'http://localhost:4201',
  pagesFallback,
  production,
];
const apiEnvironment: ApiEnvironment = {
  SQL_SERVER: 'unused.example.invalid',
  SQL_DATABASE: 'unused',
  SQL_USER: 'unused',
  SQL_PASSWORD: 'not-a-real-secret',
  ALLOWED_ORIGINS: configuredOrigins('wrangler.jsonc'),
};
const kassandraEnvironment: KassandraEnvironment = {
  JUYO_API_URL: 'https://hotel.example.invalid/api/v1',
  MCP_PUBLIC_URL: 'https://assistant.example.invalid/mcp',
  OPENAI_API_KEY: 'unit-test-key',
  ALLOWED_ORIGINS: configuredOrigins('wrangler.kassandra.jsonc'),
};

// Exercise the exported compute gateway with deployed config values. These
// requests finish before authentication/SQL and never access object storage.
const gateway = new JuyoSqlGateway(
  {
    get storage() {
      throw new Error('CORS must not access Durable Object storage.');
    },
  },
  apiEnvironment,
);
const targets = [
  {
    name: 'SQL API',
    url: 'https://hotel.example.invalid/api/v1/sessions/current',
    fetch: (request: Request) => gateway.fetch(request),
  },
  {
    name: 'Kassandra',
    url: 'https://assistant.example.invalid/mcp',
    fetch: (request: Request) => handleKassandra(request, kassandraEnvironment),
  },
];

test('deployed Worker allowlists preserve local, production and Pages fallback access', () => {
  assert.deepEqual([...allowedOrigins(apiEnvironment)], approved);
  assert.deepEqual(kassandraEnvironment.ALLOWED_ORIGINS?.split(','), approved);
});

test('configured local and production origins pass preflight through both Workers', async () => {
  for (const target of targets) {
    for (const origin of approved) {
      const response = await target.fetch(
        new Request(target.url, {
          method: 'OPTIONS',
          headers: {
            Origin: origin,
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'Authorization, Content-Type',
          },
        }),
      );
      assert.equal(response.status, 204, `${target.name}: ${origin}`);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
      assert.match(response.headers.get('Access-Control-Allow-Headers') ?? '', /Authorization/);
      assert.equal(response.headers.has('Access-Control-Allow-Credentials'), false);
      assert.equal(response.headers.get('Vary'), 'Origin');
    }
    const unauthenticated = await target.fetch(
      new Request(target.url, { headers: { Origin: production } }),
    );
    assert.equal(unauthenticated.status, 401, `${target.name} still requires authentication.`);
    assert.equal(unauthenticated.headers.get('Access-Control-Allow-Origin'), production);
  }
});

test('Pages previews, sibling projects and origin lookalikes remain rejected before authentication', async () => {
  for (const target of targets) {
    for (const origin of [
      'https://abcdef.juyo-demo.pages.dev',
      'https://another-demo.pages.dev',
      'https://juyo-demo.cristiansarghe.com.attacker.example',
      'http://juyo-demo.cristiansarghe.com',
      'https://juyo-demo.cristiansarghe.com:8443',
      'https://juyo-demo.pages.dev.attacker.example',
      'http://juyo-demo.pages.dev',
      'https://juyo-demo.pages.dev:8443',
      'null',
    ]) {
      const response = await target.fetch(
        new Request(target.url, { method: 'OPTIONS', headers: { Origin: origin } }),
      );
      assert.equal(response.status, 403, `${target.name}: ${origin}`);
      assert.equal(response.headers.has('Access-Control-Allow-Origin'), false);
      assert.equal((await response.json()).code, 'ORIGIN_NOT_ALLOWED');
    }
  }
});
