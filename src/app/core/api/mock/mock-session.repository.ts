import type { User } from '../../models';
import { MockRepositoryError } from './mock-repository-error';

const SESSION_KEY = 'juyo.demo.user';
let memoryUser: User | null | undefined;

function restoredUser(): User | null {
  try {
    const value: unknown = JSON.parse(
      sessionStorage.getItem(SESSION_KEY) ?? localStorage.getItem(SESSION_KEY) ?? 'null',
    );
    if (
      value &&
      typeof value === 'object' &&
      'name' in value &&
      'email' in value &&
      typeof value.name === 'string' &&
      typeof value.email === 'string' &&
      value.name.length <= 100 &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)
    )
      return { name: value.name, email: value.email };
  } catch {
    /* A local in-memory session still works without browser storage. */
  }
  return null;
}

export function getCurrentSession(): User | null {
  if (memoryUser === undefined) memoryUser = restoredUser();
  return memoryUser;
}

/** Local credential validation is deliberately confined to the mock API. */
export function createSession(value: unknown): User {
  if (!value || typeof value !== 'object')
    throw new MockRepositoryError(422, 'invalid_credentials', 'Enter an email and password.');
  const request = value as { email?: unknown; password?: unknown; remember?: unknown };
  if (typeof request.email !== 'string')
    throw new MockRepositoryError(422, 'invalid_email', 'Enter a valid email address.');
  const email = request.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
    throw new MockRepositoryError(422, 'invalid_email', 'Enter a valid email address.');
  if (
    typeof request.password !== 'string' ||
    request.password.length < 8 ||
    request.password.length > 256
  )
    throw new MockRepositoryError(
      422,
      'invalid_password',
      'Use a password with 8 to 256 characters.',
    );
  if (request.remember !== undefined && typeof request.remember !== 'boolean')
    throw new MockRepositoryError(422, 'invalid_remember', 'Choose a valid session preference.');
  const firstName = email.split('@')[0].split(/[._-]/)[0];
  memoryUser = { name: firstName.charAt(0).toUpperCase() + firstName.slice(1), email };
  try {
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(SESSION_KEY);
    (request.remember ? localStorage : sessionStorage).setItem(
      SESSION_KEY,
      JSON.stringify(memoryUser),
    );
  } catch {
    /* Passwords are never stored; memory survives this visit only. */
  }
  return memoryUser;
}

export function deleteSession(): void {
  memoryUser = null;
  try {
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* In-memory session is still cleared. */
  }
}
