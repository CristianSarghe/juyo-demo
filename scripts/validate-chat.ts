import { MockChatRepository } from '../src/app/core/api/mock/mock-chat.repository';
import {
  createSession,
  getCurrentSession,
  deleteSession,
} from '../src/app/core/api/mock/mock-session.repository';
import { MockRepositoryError } from '../src/app/core/api/mock/mock-repository-error';
import assert from 'node:assert/strict';
import { demoReply, PROPERTIES } from '../src/app/core/demo-data.ts';
import {
  BOOKING_POSITIONS,
  DAILY_ROOM_STATES,
  REPORTING_PERIODS,
  RESERVATION_NIGHTS,
} from '../src/app/core/network.data.ts';

const cents = (value: number): number => Math.round(value * 100);
const money = (value: number): string =>
  new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
const percent = (part: number, total: number): string =>
  new Intl.NumberFormat('en-IE', { maximumFractionDigits: 2 }).format(
    total ? Math.round((part / total) * 10_000) / 100 : 0,
  ) + '%';
let checked = 0;
for (const property of PROPERTIES) {
  for (const period of REPORTING_PERIODS) {
    const inScope = <T extends { hotelId: string }>(rows: readonly T[]) =>
      rows.filter((row) => property.id === 'portfolio' || row.hotelId === property.id);
    for (const topic of [
      'occupancy',
      'room revenue',
      'costs',
      'restaurant',
      'booking channel',
      'facilities',
      'room status',
      'reservations',
    ]) {
      const reply = demoReply(`${period.label} ${topic}`, property);
      assert.ok(
        !/NaN|Infinity|undefined|DEV ·|development data/.test(JSON.stringify(reply)),
        `${property.id}/${period.key}/${topic}: valid response copy`,
      );
      assert.ok(
        reply.insight?.reportingPeriod || reply.content.includes(period.label),
        `${topic}: identifies date or month`,
      );
      checked++;
    }
    const positions = inScope(BOOKING_POSITIONS).filter((row) =>
      row.stayDate.startsWith(period.key),
    );
    const revenue = demoReply(`${period.label} room revenue`, property).insight!;
    const actualCents = positions.reduce((sum, row) => sum + cents(row.actualRoomRevenue ?? 0), 0);
    const bookedCents = positions.reduce((sum, row) => sum + cents(row.revenueOnBooks ?? 0), 0);
    assert.equal(
      revenue.metrics.find((metric) => metric.label === 'Earned')?.value,
      money(actualCents / 100),
    );
    assert.equal(
      revenue.metrics.find((metric) => metric.label === 'On the books')?.value,
      money(bookedCents / 100),
    );
    const nights = inScope(RESERVATION_NIGHTS).filter((row) => row.date.startsWith(period.key));
    const capacity = positions.reduce((sum, row) => sum + row.roomsAvailable, 0);
    const occupancy = demoReply(`${period.label} occupancy`, property).insight!;
    assert.equal(
      occupancy.metrics.find((metric) => metric.label === 'Occupancy')?.value,
      percent(nights.length, capacity),
    );
    if (period.key === '2026-12') {
      const costs = demoReply('December operating profit', property).insight!;
      assert.equal(
        costs.metrics.find((metric) => metric.label === 'Actual operating result')?.value,
        '—',
        'No invented December actual profit',
      );
      assert.equal(
        costs.metrics.find((metric) => metric.label === 'Actual costs')?.value,
        '—',
        'No future planned expenses called actual',
      );
    }
    const date = period.endDate;
    const rooms = demoReply(`Room status on ${date}`, property).insight!;
    const states = inScope(DAILY_ROOM_STATES).filter((row) => row.date === date);
    assert.equal(
      rooms.metrics[0].value,
      String(states.filter((row) => row.occupancy === 'available').length),
    );
    assert.equal(rooms.metrics[1].label, date < '2026-11-14' ? 'Occupied' : 'Booked');
  }
}
console.log(
  `Validated ${checked} hotel/month/topic answers, month-specific room revenue and occupancy, explicit room dates, and future-profit safeguards.`,
);

// Exercise the mock API persistence boundary, independently of the live facade.
const localValues = new Map<string, string>();
const sessionValues = new Map<string, string>();
const store = (values: Map<string, string>) => ({
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value),
  removeItem: (key: string) => values.delete(key),
});
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: store(localValues),
});
Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true,
  value: store(sessionValues),
});
const repository = new MockChatRepository();
const context = {
  title: 'November revenue',
  propertyId: 'dev-ber',
  month: '2026-11',
  roomDate: '2026-11-14',
};
assert.throws(() => repository.create({ ...context, propertyId: 'unknown' }), MockRepositoryError);
const conversation = repository.create(context);
assert.equal(repository.get(conversation.id)?.messages.length, 0);
assert.throws(
  () => repository.appendMessage(conversation.id, { content: '' }),
  MockRepositoryError,
);
assert.equal(
  repository.get(conversation.id)?.messages.length,
  0,
  'Rejected messages leave history unchanged',
);
const answered = repository.appendMessage(conversation.id, { content: 'November room revenue' });
assert.deepEqual(
  answered.messages.map((message) => message.role),
  ['user', 'assistant'],
);
assert.equal(
  answered.messages[1].insight?.metrics.find((metric) => metric.label === 'On the books')?.value,
  demoReply(
    'November room revenue',
    PROPERTIES.find((property) => property.id === 'dev-ber')!,
    '2026-11',
    '2026-11-14',
  ).insight?.metrics.find((metric) => metric.label === 'On the books')?.value,
);
const copy = repository.list();
copy[0].title = 'Mutated caller copy';
assert.equal(
  repository.get(conversation.id)?.title,
  'November revenue',
  'API consumers cannot mutate repository state',
);
assert.equal(
  new MockChatRepository().get(conversation.id)?.messages.length,
  2,
  'Mock history persists across repository recreation',
);
repository.remove(conversation.id);
assert.equal(repository.get(conversation.id), null);
assert.throws(
  () => repository.appendMessage(conversation.id, { content: 'hello' }),
  MockRepositoryError,
);
assert.throws(
  () => createSession({ email: 'invalid', password: 'local-test-password' }),
  MockRepositoryError,
);
const user = createSession({ email: 'QA@EXAMPLE.COM', password: 'local-test-password' });
assert.equal(user.email, 'qa@example.com');
assert.deepEqual(getCurrentSession(), user);
assert(
  ![...localValues.values(), ...sessionValues.values()].some((value) =>
    value.includes('local-test-password'),
  ),
  'Mock session never persists credentials',
);
deleteSession();
assert.equal(getCurrentSession(), null);
console.log(
  'Validated mock conversation create/send/delete, immutable responses, persistence, validation and credential-free session storage.',
);
