import assert from 'node:assert/strict';
import { citedAnswer } from '../src/app/core/chat-citations';

const content = 'Call the plumber on +32 2 123 45 67. Then confirm availability.';
const link = { url: 'https://example.com/contact', title: 'Business contact' };
const result = citedAnswer({
  content,
  citations: [
    { ...link, startIndex: 20, endIndex: 34 },
    { ...link, startIndex: 0, endIndex: content.length },
    { url: 'javascript:alert(1)', title: 'Bad', startIndex: 0, endIndex: 4 },
    { ...link, startIndex: 0, endIndex: 999 },
  ],
});
assert.equal(result.segments.map((item) => item.text).join(''), content);
assert.equal(result.sources.length, 1);
assert.equal(
  citedAnswer({
    content,
    citations: [{ ...link, startIndex: 5, endIndex: 17 }],
    webSources: [{ url: 'https://example.org/unused', title: 'Unused search result' }],
  }).sources.length,
  1,
);
assert.deepEqual(
  result.segments.map((item) => item.references[0].number),
  [1, 1],
);
assert.deepEqual(citedAnswer({ content: '<script>text only</script>' }).segments, [
  { text: '<script>text only</script>', references: [] },
]);
assert.equal(
  citedAnswer({ content, webSources: [{ ...link, url: 'https://user:pass@example.com' }] }).sources
    .length,
  0,
);
console.log('Chat citation text, numbering and unsafe-link checks passed.');
