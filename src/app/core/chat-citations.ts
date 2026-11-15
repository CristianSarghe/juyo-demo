import type { Message, WebSource } from './models';

export interface CitedSegment {
  text: string;
  references: { number: number; source: WebSource }[];
}

export function safeWebSource(source: WebSource): boolean {
  try {
    const url = new URL(source.url);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Build text nodes and ordinary links; never render model HTML. Offsets use UTF-16. */
export function citedAnswer(message: Pick<Message, 'content' | 'citations' | 'webSources'>): {
  segments: CitedSegment[];
  sources: WebSource[];
} {
  const sources: WebSource[] = [];
  const numberFor = (source: WebSource) => {
    let index = sources.findIndex((item) => item.url === source.url);
    if (index < 0) index = sources.push(source) - 1;
    return index + 1;
  };
  const ends = new Map<number, { number: number; source: WebSource }[]>();
  for (const citation of (message.citations ?? [])
    .slice(0, 64)
    .sort((a, b) => a.endIndex - b.endIndex)) {
    if (
      !safeWebSource(citation) ||
      !Number.isInteger(citation.startIndex) ||
      !Number.isInteger(citation.endIndex) ||
      citation.startIndex < 0 ||
      citation.endIndex <= citation.startIndex ||
      citation.endIndex > message.content.length
    )
      continue;
    const references = ends.get(citation.endIndex) ?? [];
    const number = numberFor(citation);
    if (!references.some((item) => item.number === number))
      references.push({ number, source: citation });
    ends.set(citation.endIndex, references);
  }
  const segments: CitedSegment[] = [];
  let cursor = 0;
  for (const [end, references] of ends) {
    segments.push({ text: message.content.slice(cursor, end), references });
    cursor = end;
  }
  if (cursor < message.content.length)
    segments.push({ text: message.content.slice(cursor), references: [] });
  // A concise bibliography shows evidence actually cited in this answer, rather
  // than every search result consulted. Retain source-only response support.
  if (!sources.length) {
    for (const source of (message.webSources ?? []).slice(0, 32))
      if (safeWebSource(source)) numberFor(source);
  }
  return { segments, sources };
}
