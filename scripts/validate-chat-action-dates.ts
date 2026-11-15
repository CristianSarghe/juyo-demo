import '@angular/compiler';
import assert from 'node:assert/strict';
import { formatChatActionDate } from '../src/app/shared/chat-action.component';

const previousTimezone = process.env.TZ;
try {
  for (const timezone of [
    'Europe/Bucharest',
    'Europe/Brussels',
    'America/Los_Angeles',
    'Pacific/Auckland',
    'UTC',
  ]) {
    process.env.TZ = timezone;
    for (const [date, expected] of [
      ['2026-11-19', '19 Nov 2026'],
      ['2026-11-20', '20 Nov 2026'],
      ['2026-10-25', '25 Oct 2026'],
      ['2026-11-01', '1 Nov 2026'],
      ['2026-12-31', '31 Dec 2026'],
    ]) {
      assert.equal(
        formatChatActionDate(date),
        expected,
        `${date} stays the same calendar day in ${timezone}`,
      );
    }
  }
  assert.equal(formatChatActionDate('invalid'), '—');
  console.log('Validated action date labels across five timezones, DST and month/year boundaries.');
} finally {
  if (previousTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = previousTimezone;
}
