import sql from 'mssql';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { reject } from './problem';
import type { User } from './domain/models';
import { DEMO_ACCOUNTS } from './demo-accounts';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export interface AuthenticatedUser extends User {
  id: string;
}

export class SessionRepository {
  constructor(
    private readonly pool: sql.ConnectionPool,
    private readonly connect: () => Promise<sql.ConnectionPool> = () => Promise.resolve(pool),
  ) {}
  async authenticate(header?: string): Promise<AuthenticatedUser> {
    if (!header?.startsWith('Bearer '))
      return reject(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    const token = header.slice(7);
    if (!/^[a-f0-9]{64}$/.test(token))
      return reject(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    await this.connect();
    const result = await this.pool.request().input('tokenHash', sql.Char(64), hashToken(token))
      .query(`
      SELECT u.Id AS id,u.Email AS email,u.Name AS name
      FROM juyo_api.ApiSession s JOIN juyo_api.ApiUser u ON u.Id=s.UserId
      WHERE s.TokenHash=@tokenHash AND s.ExpiresAt>SYSUTCDATETIME() AND u.Disabled=0;`);
    if (!result.recordset[0])
      return reject(401, 'UNAUTHENTICATED', 'Your session has expired. Sign in again.');
    return result.recordset[0] as AuthenticatedUser;
  }
  async login(body: unknown): Promise<{ user: User; token: string }> {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return reject(422, 'INVALID_CREDENTIALS', 'Enter an email and password.');
    const { email, password, remember } = body as Record<string, unknown>;
    if (
      typeof email !== 'string' ||
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ||
      typeof password !== 'string' ||
      password.length < 8 ||
      password.length > 256 ||
      (remember !== undefined && typeof remember !== 'boolean')
    )
      return reject(422, 'INVALID_CREDENTIALS', 'Enter a valid email and password.');
    const normalizedEmail = email.trim().toLowerCase();
    const account = DEMO_ACCOUNTS.find((candidate) => candidate.email === normalizedEmail);
    // Reject invalid demo credentials before opening a SQL/TLS connection.
    if (!account || password !== account.password)
      return reject(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    await this.connect();
    const found = await this.pool.request().input('email', sql.NVarChar(254), account.email).query(`
      SELECT Id AS id,Email AS email,Name AS name,Disabled AS disabled
      FROM juyo_api.ApiUser WHERE Email=@email;`);
    const row = found.recordset[0];
    if (!row || row.disabled)
      return reject(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    const token = randomBytes(32).toString('hex');
    const days = remember ? 30 : 1;
    await this.pool
      .request()
      .input('userId', sql.UniqueIdentifier, row.id)
      .input('tokenHash', sql.Char(64), hashToken(token))
      .input('days', sql.Int, days).query(`
      SET XACT_ABORT ON;
      BEGIN TRANSACTION;
      DELETE FROM juyo_api.ApiSession WHERE ExpiresAt<=SYSUTCDATETIME();
      INSERT INTO juyo_api.ApiSession(TokenHash,UserId,CreatedAt,ExpiresAt)
      VALUES(@tokenHash,@userId,SYSUTCDATETIME(),DATEADD(day,@days,SYSUTCDATETIME()));
      COMMIT;`);
    return { user: { name: row.name, email: row.email }, token };
  }
  async logout(header?: string): Promise<void> {
    const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (!/^[a-f0-9]{64}$/.test(token)) return;
    await this.connect();
    await this.pool
      .request()
      .input('tokenHash', sql.Char(64), hashToken(token))
      .query('DELETE FROM juyo_api.ApiSession WHERE TokenHash=@tokenHash;');
  }
  /** Idempotent identity provisioning; existing IDs and disabled states remain authoritative. */
  async provisionDemoAccounts(): Promise<void> {
    await this.connect();
    const request = this.pool.request();
    const statements = DEMO_ACCOUNTS.map((account, index) => {
      request
        .input(`id${index}`, sql.UniqueIdentifier, randomUUID())
        .input(`email${index}`, sql.NVarChar(254), account.email)
        .input(`name${index}`, sql.NVarChar(100), account.name);
      return `
        IF NOT EXISTS(SELECT 1 FROM juyo_api.ApiUser WITH (UPDLOCK,HOLDLOCK) WHERE Email=@email${index})
          INSERT INTO juyo_api.ApiUser(Id,Email,Name,PasswordHash,CreatedAt,Disabled)
          VALUES(@id${index},@email${index},@name${index},NULL,SYSUTCDATETIME(),0);
        ELSE
          UPDATE juyo_api.ApiUser SET Name=@name${index} WHERE Email=@email${index};`;
    });
    await request.query(`
      SET XACT_ABORT ON;
      BEGIN TRANSACTION;
      ${statements.join('\n')}
      COMMIT;`);
  }
}
