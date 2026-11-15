import type { Message, WebSource, WebCitation } from './models';

function source(value: unknown): WebSource | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (
    typeof item.url !== 'string' ||
    item.url.length > 2048 ||
    typeof item.title !== 'string' ||
    !item.title.trim() ||
    item.title.length > 300
  )
    return null;
  try {
    const url = new URL(item.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return { url: url.href, title: item.title.trim() };
  } catch {
    return null;
  }
}

/** Only bounded, safe source links cross inference and persistence boundaries. */
export function messageSources(
  value: Record<string, unknown>,
  content?: string,
): Pick<Message, 'citations' | 'webSources'> {
  const webSources = (Array.isArray(value.webSources) ? value.webSources.slice(0, 32) : [])
    .map(source)
    .filter((item): item is WebSource => !!item);
  const citations: WebCitation[] = [];
  for (const raw of Array.isArray(value.citations) ? value.citations.slice(0, 64) : []) {
    const item = raw as Record<string, unknown>;
    const link = source(item);
    if (
      !link ||
      !Number.isInteger(item.startIndex) ||
      !Number.isInteger(item.endIndex) ||
      (item.startIndex as number) < 0 ||
      (item.endIndex as number) <= (item.startIndex as number) ||
      (item.endIndex as number) > (content?.length ?? 10000)
    )
      continue;
    citations.push({
      ...link,
      startIndex: item.startIndex as number,
      endIndex: item.endIndex as number,
    });
  }
  return {
    ...(webSources.length ? { webSources } : {}),
    ...(citations.length ? { citations } : {}),
  };
}
