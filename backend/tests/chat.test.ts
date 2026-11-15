import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createChatAnswers } from '../src/chat/reply.js';
import type { HotelNetwork } from '../src/domain/network.models.js';

test('analytics replies use the supplied workspace calendar and hotel facts', () => {
  // Offline verification fixture only; deployed chat modules never import this export.
  const text = readFileSync(
    new URL('../../public/data/hotel-network.json', import.meta.url),
    'utf8',
  );
  const data = JSON.parse(text.replaceAll('2026', '2027')) as HotelNetwork;
  const reply = createChatAnswers(data);
  for (const hotel of data.hotels) {
    for (const period of data.reportingPeriods) {
      for (const topic of [
        'occupancy',
        'revenue',
        'channel costs',
        'operating profit',
        'restaurants',
        'facilities',
        'room status',
        'reservations',
      ]) {
        const answer = reply(
          topic,
          { id: hotel.id, name: hotel.name, location: hotel.city },
          period.key,
          period.startDate,
        );
        assert(answer.content || answer.insight, 'Every supported topic returns an answer.');
        const output = JSON.stringify(answer);
        assert(!output.includes('2026'), 'The API does not retain the fixture year.');
        assert(!/\bNaN\b|\bundefined\b/.test(output), 'Answers contain valid calculated fields.');
      }
    }
  }
});
