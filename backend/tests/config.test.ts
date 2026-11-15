import assert from 'node:assert/strict';
import test from 'node:test';
import { allowedOrigins, type ApiEnvironment } from '../src/config.js';

const env: ApiEnvironment = {
  SQL_SERVER: 'unused.example.invalid',
  SQL_DATABASE: 'unused',
  SQL_USER: 'unused',
  SQL_PASSWORD: 'not-a-real-secret',
};

test('default CORS allows the two local frontend ports without allowing arbitrary origins', () => {
  const origins = allowedOrigins(env);
  assert.deepEqual([...origins], [
    'http://127.0.0.1:4200',
    'http://localhost:4200',
    'http://127.0.0.1:4201',
    'http://localhost:4201',
  ]);
  assert.equal(origins.has('http://127.0.0.1:4202'), false);
  assert.equal(origins.has('https://untrusted.example.invalid'), false);
});

test('an explicit CORS allowlist replaces defaults and trims empty entries', () => {
  assert.deepEqual(
    [...allowedOrigins({ ...env, ALLOWED_ORIGINS: ' http://localhost:4201, , ' })],
    ['http://localhost:4201'],
  );
});
