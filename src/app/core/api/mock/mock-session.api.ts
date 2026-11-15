import { HttpErrorResponse, HttpHeaders, HttpRequest, HttpResponse } from '@angular/common/http';
import { createSession, deleteSession, getCurrentSession } from './mock-session.repository';
import { MockRepositoryError } from './mock-repository-error';

/** Anonymous startup needs session state only, without loading reporting fixtures. */
export function handleMockSession(
  request: HttpRequest<unknown>,
  base: string,
): HttpResponse<unknown> {
  const normalizedBase = base.replace(/\/$/, '');
  const basePath = new URL(normalizedBase, 'http://localhost').pathname;
  const path = new URL(request.urlWithParams, 'http://localhost').pathname
    .slice(basePath.length)
    .replace(/\/$/, '');
  const allowed =
    path === '/sessions' ? ['POST'] : path === '/sessions/current' ? ['GET', 'DELETE'] : [];
  try {
    if (!allowed.length)
      throw new MockRepositoryError(404, 'NOT_FOUND', 'Session resource not found.');
    if (!allowed.includes(request.method))
      throw new MockRepositoryError(
        405,
        'METHOD_NOT_ALLOWED',
        `Use ${allowed.join(' or ')} for this resource.`,
      );
    if (path === '/sessions' && request.method === 'POST')
      return new HttpResponse({
        status: 201,
        body: { user: structuredClone(createSession(request.body)) },
        headers: new HttpHeaders({
          Location: `${normalizedBase}/sessions/current`,
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        }),
      });
    if (request.method === 'DELETE') {
      deleteSession();
      return new HttpResponse({
        status: 204,
        headers: new HttpHeaders({ 'Cache-Control': 'no-store' }),
      });
    }
    const user = getCurrentSession();
    if (!user) throw new MockRepositoryError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    return new HttpResponse({
      status: 200,
      body: { user: structuredClone(user) },
      headers: new HttpHeaders({ 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }),
    });
  } catch (error) {
    const failure =
      error instanceof MockRepositoryError
        ? error
        : new MockRepositoryError(500, 'INTERNAL_ERROR', 'Could not complete the session request.');
    throw new HttpErrorResponse({
      status: failure.status,
      url: request.url,
      headers: new HttpHeaders({
        'Content-Type': 'application/problem+json',
        ...(failure.status === 405 ? { Allow: allowed.join(', ') } : {}),
      }),
      error: {
        type: 'about:blank',
        title: 'Session request rejected',
        status: failure.status,
        code: failure.code,
        detail: failure.message,
      },
    });
  }
}
