import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import type sql from 'mssql';
import { SessionRepository } from '../src/auth.js';
import { DEMO_ACCOUNTS } from '../src/demo-accounts.js';
import { ApiProblemError } from '../src/problem.js';

interface Identity {
  id: string;
  name: string;
  email: string;
  disabled: boolean;
}

function environment() {
  const users = new Map<string, Identity>(
    DEMO_ACCOUNTS.map(({ name, email }) => [
      email,
      { id: randomUUID(), name, email, disabled: false },
    ]),
  );
  const sessions = new Map<string, string>();
  const calls: { text: string; values: Record<string, unknown> }[] = [];
  let connections = 0;
  let failInsert = false;
  const pool = {
    request() {
      const values: Record<string, unknown> = {};
      return {
        input(name: string, _type: unknown, value: unknown) {
          values[name] = value;
          return this;
        },
        async query(text: string) {
          calls.push({ text, values });
          if (text.includes('FROM juyo_api.ApiUser WHERE Email=@email')) {
            const user = users.get(String(values['email']));
            return { recordset: user ? [user] : [] };
          }
          if (text.includes('INSERT INTO juyo_api.ApiSession')) {
            if (failInsert) throw new Error('Database unavailable');
            sessions.set(String(values['tokenHash']), String(values['userId']));
            return { recordset: [] };
          }
          if (text.includes('JOIN juyo_api.ApiUser')) {
            const id = sessions.get(String(values['tokenHash']));
            const user = [...users.values()].find(
              (candidate) => candidate.id === id && !candidate.disabled,
            );
            return { recordset: user ? [user] : [] };
          }
          if (text.includes('DELETE FROM juyo_api.ApiSession')) {
            sessions.delete(String(values['tokenHash']));
            return { recordset: [] };
          }
          throw new Error('Unexpected SQL request');
        },
      };
    },
  };
  const repository = new SessionRepository(pool as unknown as sql.ConnectionPool, async () => {
    connections++;
    return pool as unknown as sql.ConnectionPool;
  });
  return {
    repository,
    users,
    sessions,
    calls,
    connections: () => connections,
    failInsert: () => {
      failInsert = true;
    },
  };
}

const isProblem = (status: number) => (error: unknown) =>
  error instanceof ApiProblemError &&
  error.status === status &&
  error.code === 'INVALID_CREDENTIALS';
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

test('invalid or unmatched demo credentials never connect to SQL', async () => {
  const { repository, calls, connections } = environment();
  const invalidBodies: unknown[] = [
    null,
    [],
    {},
    { email: 'alex', password: 'juyo-demo' },
    { username: 'alex', password: 'juyo-demo' },
    { email: 42, password: 'juyo-demo' },
    { email: 'alex@juyo.local', password: '' },
    { email: 'alex@juyo.local', password: 'x'.repeat(257) },
    { email: 'alex@juyo.local', password: 'juyo-demo', remember: 'yes' },
  ];
  for (const body of invalidBodies) await assert.rejects(repository.login(body), isProblem(422));
  for (const body of [
    { email: 'missing@juyo.local', password: 'juyo-demo' },
    { email: 'alex@juyo.local', password: 'Juyo-demo' },
    { email: 'alex@juyo.local', password: 'juyo-demo ' },
    { email: 'admin@juyo.local', password: 'juyo-demo' },
  ])
    await assert.rejects(repository.login(body), isProblem(401));
  assert.equal(connections(), 0);
  assert.equal(calls.length, 0);
});

test('each hardcoded demo account creates an opaque session after exact password comparison', async () => {
  const app = environment();
  for (const account of DEMO_ACCOUNTS) {
    const result = await app.repository.login({
      email: ` ${account.email.toUpperCase()} `,
      password: account.password,
    });
    assert.deepEqual(result.user, { name: account.name, email: account.email });
    assert.match(result.token, /^[a-f0-9]{64}$/);
    assert.equal(app.sessions.get(tokenHash(result.token)), app.users.get(account.email)!.id);
    const insertion = app.calls.at(-1)!;
    assert.equal(insertion.values['days'], 1);
    assert.equal(insertion.values['tokenHash'], tokenHash(result.token));
    assert(
      !Object.values(insertion.values).includes(result.token),
      'SQL receives only the token hash.',
    );
    assert(!JSON.stringify(result).includes(account.password), 'Responses omit demo passwords.');
  }
  assert.equal(app.connections(), DEMO_ACCOUNTS.length);
  assert.equal(new Set(app.sessions.keys()).size, DEMO_ACCOUNTS.length);
  for (const call of app.calls) {
    assert(
      !call.text.includes('PasswordHash'),
      'Runtime auth does not read stored password hashes.',
    );
    assert(!Object.keys(call.values).some((name) => /password/i.test(name)));
  }
});

test('remembered demo sessions retain the existing longer expiration policy', async () => {
  const app = environment();
  await app.repository.login({ ...DEMO_ACCOUNTS[0], remember: true });
  assert.equal(app.calls.at(-1)!.values['days'], 30);
});

test('valid demo credentials require an enabled, provisioned durable identity', async () => {
  for (const absent of [true, false]) {
    const app = environment();
    if (absent) app.users.delete(DEMO_ACCOUNTS[0].email);
    else app.users.get(DEMO_ACCOUNTS[0].email)!.disabled = true;
    await assert.rejects(app.repository.login(DEMO_ACCOUNTS[0]), isProblem(401));
    assert.equal(app.connections(), 1);
    assert.equal(app.calls.length, 1);
    assert.equal(app.sessions.size, 0);
  }
});

test('failed session insertion cannot return a successful login', async () => {
  const app = environment();
  app.failInsert();
  await assert.rejects(app.repository.login(DEMO_ACCOUNTS[0]), /Database unavailable/);
  assert.equal(app.sessions.size, 0);
});

test('demo sessions restore identity, reject malformed tokens and end through logout', async () => {
  const app = environment();
  for (const header of [undefined, '', 'Basic invalid', 'Bearer not-an-opaque-token']) {
    await assert.rejects(
      app.repository.authenticate(header),
      (error: unknown) => error instanceof ApiProblemError && error.status === 401,
    );
    await app.repository.logout(header);
  }
  assert.equal(app.connections(), 0, 'Malformed tokens never open SQL connections.');
  const signedIn = await app.repository.login(DEMO_ACCOUNTS[0]);
  const header = `Bearer ${signedIn.token}`;
  const user = await app.repository.authenticate(header);
  assert.equal(user.id, app.users.get(DEMO_ACCOUNTS[0].email)!.id);
  assert.equal(user.email, DEMO_ACCOUNTS[0].email);
  await app.repository.logout(header);
  assert.equal(app.sessions.size, 0);
  await assert.rejects(
    app.repository.authenticate(header),
    (error: unknown) => error instanceof ApiProblemError && error.status === 401,
  );
  await app.repository.logout(header);
});
