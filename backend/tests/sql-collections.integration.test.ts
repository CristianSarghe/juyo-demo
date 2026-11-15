import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from '../src/database.js';
import { readEnvironment } from '../src/config.js';
import { SqlNetworkRepository } from '../src/data/sql-network.repository.js';

test(
  'SQL collection pages represent genuinely empty filters and beyond-last pages as arrays',
  {
    skip: process.env.SQL_INTEGRATION !== '1',
    timeout: 60_000,
  },
  async () => {
    const database = createDatabase(readEnvironment());
    try {
      await database.connect();
      const repository = new SqlNetworkRepository(database.pool);
      const reference = await repository.loadReference();
      assert.equal(reference.hotels.length, 4);
      for (const hotel of reference.hotels) {
        assert(
          hotel.address?.line1.trim(),
          'Configured hotel street address reaches reference data.',
        );
        assert(
          hotel.address.postalCode.trim(),
          'Configured hotel postal code reaches reference data.',
        );
      }
      const hotel = reference.hotels[0];
      const hotels = await repository.readCollection(
        'hotels',
        new URLSearchParams({ pageSize: '100' }),
      );
      assert.deepEqual(
        hotels.items,
        reference.hotels,
        'Reference and paginated hotel projections use the same nested address DTO.',
      );
      const events = await repository.readCollection(
        'events',
        new URLSearchParams({ hotelId: hotel.id, pageSize: '100' }),
      );
      assert(events.total <= 100, 'Test scope must retrieve all of its events.');
      const emptyDate = reference.dates.find(
        (date) => !events.items.some((event) => event.startDate <= date && event.endDate >= date),
      );
      assert(emptyDate, 'The reporting calendar contains a real no-event day.');
      const empty = await repository.readCollection(
        'events',
        new URLSearchParams({ hotelId: hotel.id, from: emptyDate, to: emptyDate, pageSize: '100' }),
      );
      assert.deepEqual(
        empty.items,
        [],
        'No events is a valid empty collection, not a decode failure.',
      );
      assert.equal(empty.total, 0);
      assert.equal(empty.page, 1);
      const beyondLast = await repository.readCollection(
        'events',
        new URLSearchParams({ hotelId: hotel.id, page: '100', pageSize: '100' }),
      );
      assert.deepEqual(beyondLast.items, [], 'A page beyond the final row is a valid empty page.');
      assert.equal(beyondLast.total, events.total, 'Total remains independent of page offset.');
      assert.equal(beyondLast.page, 100);
    } finally {
      await database.close();
    }
  },
);

test(
  'SQL room-state and reservation-night type filters preserve hotel/date scope and pagination totals',
  { skip: process.env.SQL_INTEGRATION !== '1', timeout: 90_000 },
  async () => {
    const database = createDatabase(readEnvironment());
    try {
      await database.connect();
      const repository = new SqlNetworkRepository(database.pool);
      const reference = await repository.loadReference();
      const period = reference.reportingPeriods.find((row) => row.key === reference.bookingSnapshot.asOf.slice(0, 7))!;
      const types = await repository.readCollection('roomTypes', new URLSearchParams({ pageSize: '1000' }));
      const type = types.items[0];
      const rooms = await repository.readCollection('rooms', new URLSearchParams({ hotelId: type.hotelId, roomTypeId: type.id, pageSize: '1000' }));
      const roomIds = new Set(rooms.items.map((room) => room.id));
      assert(roomIds.size > 0);
      for (const key of ['dailyRoomStates', 'reservationNights'] as const) {
        const scope = { hotelId: type.hotelId, from: period.startDate, to: period.endDate };
        const unfiltered = await repository.readCollection(key, new URLSearchParams({ ...scope, pageSize: '1000' }));
        assert.equal(unfiltered.items.length, unfiltered.total, 'The bounded hotel/month oracle fits one SQL page.');
        const expected = unfiltered.items.filter((row) => roomIds.has(row.roomId!));
        assert(expected.length > 7 && expected.length < unfiltered.total);
        const query = { ...scope, roomTypeId: type.id, pageSize: '7' };
        const first = await repository.readCollection(key, new URLSearchParams(query));
        const second = await repository.readCollection(key, new URLSearchParams({ ...query, page: '2' }));
        assert.equal(first.total, expected.length);
        assert.equal(second.total, expected.length);
        assert.deepEqual(first.items, expected.slice(0, 7));
        assert.deepEqual(second.items, expected.slice(7, 14));
        assert([...first.items, ...second.items].every((row) => roomIds.has(row.roomId!)));
        const otherHotel = reference.hotels.find((hotel) => hotel.id !== type.hotelId)!;
        const mismatched = await repository.readCollection(key, new URLSearchParams({ ...query, hotelId: otherHotel.id }));
        assert.equal(mismatched.total, 0);
        assert.deepEqual(mismatched.items, []);
        const invalidType = await repository.readCollection(key, new URLSearchParams({ ...query, roomTypeId: 'not-a-configured-room-type' }));
        assert.equal(invalidType.total, 0);
        assert.deepEqual(invalidType.items, []);
      }
    } finally {
      await database.close();
    }
  },
);
