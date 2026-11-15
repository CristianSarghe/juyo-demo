import assert from 'node:assert/strict';
import test from 'node:test';
import { messageSources } from '../src/domain/chat-sources.js';
import { encodeMessagePayload, decodeMessagePayload } from '../src/domain/chat.models.js';

test('public citations survive SQL payload encoding and reject unsafe URLs and offsets', () => {
  const content = 'Call this company.';
  const source = { url: 'https://example.com/contact', title: 'Contact' };
  const sources = { citations: [{ ...source, startIndex: 5, endIndex: 17 }], webSources: [source] };
  assert.deepEqual(
    decodeMessagePayload(encodeMessagePayload({ content, ...sources }), content),
    sources,
  );
  assert.deepEqual(
    messageSources(
      {
        citations: [
          null,
          { ...source, startIndex: -1, endIndex: 3 },
          { ...source, startIndex: 0, endIndex: 99 },
          { ...source, url: 'javascript:alert(1)', startIndex: 0, endIndex: 3 },
          { ...source, url: 'https://user:password@example.com', startIndex: 0, endIndex: 3 },
        ],
      },
      content,
    ),
    {},
  );
  assert.equal(encodeMessagePayload({}), null);
});
