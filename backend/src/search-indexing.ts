/** All public demo responses, including non-HTML resources and failures, opt out of search. */
export const SEARCH_ROBOTS_POLICY = 'noindex, nofollow, nosnippet, noimageindex';

// Crawlers must be allowed to fetch URLs to discover their noindex response header.
export const SEARCH_ROBOTS_TXT =
  '# Every URL returns X-Robots-Tag: noindex. Allow crawling so search engines can read it.\n' +
  'User-agent: *\nDisallow:\n';

export function withSearchExclusion(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Robots-Tag', SEARCH_ROBOTS_POLICY);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Answer outside authentication/SQL: robots.txt must be discoverable without a session. */
export function searchRobotsResponse(request: Request): Response | null {
  if (new URL(request.url).pathname !== '/robots.txt') return null;
  return withSearchExclusion(
    new Response(request.method === 'HEAD' ? null : SEARCH_ROBOTS_TXT, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    }),
  );
}
