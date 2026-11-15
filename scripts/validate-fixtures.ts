import Ajv2020 from 'ajv/dist/2020.js';
import {
  NETWORK_DATA as data,
  REPORTING_DATES,
  REPORTING_PERIODS,
} from '../src/app/core/network.data.ts';
import { NETWORK_SCHEMA } from '../src/app/core/network.schema.ts';
import { ENUM_OPTIONS, type PropertyScope } from '../src/app/core/network.models.ts';
import {
  channelSummary,
  costTotals,
  dailyTrend,
  hotelInventory,
  hotelSummary,
} from '../src/app/core/api/mock/fixture-selectors.ts';
import { validateBookingFixtures } from './validate-booking.ts';
import { validateEventFixtures } from './validate-events.ts';
import {
  assert,
  cents,
  datesBetween,
  groupBy,
  money,
  percent,
  rateCents,
  sum,
  sumCents,
  unique,
  validDate,
} from './validation-helpers.ts';

const dates = datesBetween('2026-10-01', '2027-01-01');
const asOf = data.bookingSnapshot.asOf;
const expectedInventory = { 'dev-bru': 24, 'dev-ams': 20, 'dev-ber': 28, 'dev-opo': 16 };
const scopes: PropertyScope[] = [...data.hotels.map((hotel) => hotel.id), 'portfolio'];
const hotels = new Map(data.hotels.map((row) => [row.id, row]));
const types = new Map(data.roomTypes.map((row) => [row.id, row]));
const rooms = new Map(data.rooms.map((row) => [row.id, row]));
const facilities = new Map(data.facilities.map((row) => [row.id, row]));
const reservations = new Map(data.reservations.map((row) => [row.id, row]));
const nightsByReservation = groupBy(data.reservationNights, (row) => row.reservationId);
const nightsByDay = groupBy(data.reservationNights, (row) => `${row.hotelId}/${row.date}`);
const statesByDay = groupBy(data.dailyRoomStates, (row) => `${row.hotelId}/${row.date}`);
const activityByDay = groupBy(data.dailyFacilityActivity, (row) => `${row.hotelId}/${row.date}`);
const costsByDay = groupBy(data.dailyCosts, (row) => `${row.hotelId}/${row.date}`);
const channelsByDay = groupBy(data.dailyChannels, (row) => `${row.hotelId}/${row.date}`);
const performanceByDay = new Map(
  data.dailyPerformance.map((row) => [`${row.hotelId}/${row.date}`, row]),
);

const ajv = new Ajv2020({ allErrors: true });
ajv.addFormat('date', validDate);
const validate = ajv.compile(NETWORK_SCHEMA);
assert.ok(
  validate(data),
  `JSON Schema validation failed:\n${ajv.errorsText(validate.errors, { separator: '\n' })}`,
);
assert.equal(data.meta.testData, true);
assert.equal(data.meta.currency, 'EUR');
assert.equal(data.meta.amountBasis, 'net_excluding_vat');
assert.ok(
  NETWORK_SCHEMA.$id.endsWith(`:${data.meta.schemaVersion}`),
  'Schema version matches metadata',
);
assert.equal(data.meta.reportingPeriod.startDate, dates[0]);
assert.equal(data.meta.reportingPeriod.endDate, dates.at(-1));
assert.equal(data.meta.reportingPeriod.days, 92);
assert.equal(asOf, '2026-11-14');
assert.equal(data.meta.snapshotDate, asOf, 'Physical-room snapshot uses the same business date');
assert.deepEqual(REPORTING_DATES, dates, 'Canonical dates cover the full quarter without gaps');
assert.deepEqual(data.reportingPeriods, REPORTING_PERIODS);
assert.equal(REPORTING_PERIODS.length, 3);
assert.deepEqual(
  REPORTING_PERIODS.map((period) => period.key),
  ['2026-10', '2026-11', '2026-12'],
);
for (const period of REPORTING_PERIODS) {
  const expected = dates.filter((date) => date.startsWith(period.key));
  assert.equal(period.startDate, expected[0]);
  assert.equal(period.endDate, expected.at(-1));
  assert.equal(period.days, expected.length);
}
assert.equal(data.hotels.length, 4);
assert.equal(data.rooms.length, 88);
assert.equal(new Set(data.hotels.map((hotel) => hotel.city)).size, 4);
for (const [name, rows] of Object.entries({
  hotels: data.hotels,
  roomTypes: data.roomTypes,
  rooms: data.rooms,
  facilities: data.facilities,
  restaurants: data.restaurants,
  costs: data.costs,
  dailyCosts: data.dailyCosts,
  unitCosts: data.unitCosts,
  channels: data.channels,
  dailyChannels: data.dailyChannels,
  reservations: data.reservations,
})) {
  unique(
    rows.map((row) => row.id),
    `${name} IDs`,
  );
  for (const row of rows) {
    if ('hotelId' in row)
      assert.ok(hotels.has(row.hotelId), `${name}/${row.id}: hotel foreign key`);
  }
}
for (const hotel of data.hotels) {
  assert.ok(hotel.address, `${hotel.id}: configured sample postal address`);
  assert.ok(hotel.address.line1.trim().length > 0 && hotel.address.line1.length <= 200);
  assert.ok(hotel.address.postalCode.trim().length > 0 && hotel.address.postalCode.length <= 20);
  assert.ok(hotel.address.line2 == null || hotel.address.line2.trim().length > 0);
  assert.ok(
    !/^DEV\b/i.test(hotel.name),
    `${hotel.id}: hotel names do not contain implementation labels`,
  );
  assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: hotel.timezone }));
  const inventory = data.rooms.filter((room) => room.hotelId === hotel.id);
  assert.equal(
    inventory.length,
    expectedInventory[hotel.id],
    `${hotel.id}: physical room inventory`,
  );
  unique(
    inventory.map((room) => room.number),
    `${hotel.id}: room numbers`,
  );
  const roomTypes = data.roomTypes.filter((type) => type.hotelId === hotel.id);
  assert.equal(sum(roomTypes.map((type) => type.inventory)), inventory.length);
  for (const type of roomTypes) {
    assert.equal(
      inventory.filter((room) => room.roomTypeId === type.id).length,
      type.inventory,
      `${type.id}: type inventory`,
    );
    unique(type.facilities, `${type.id}: room facilities`);
  }
  const restaurants = data.restaurants.filter((restaurant) => restaurant.hotelId === hotel.id);
  assert.equal(restaurants.length, hotel.id === 'dev-opo' ? 0 : 1);
  for (const restaurant of restaurants) {
    const facility = facilities.get(restaurant.id);
    assert.ok(
      facility?.kind === 'restaurant' && facility.hotelId === hotel.id,
      `${restaurant.id}: matching restaurant facility`,
    );
    assert.equal(facility.capacity, restaurant.seats);
  }
  if (!restaurants.length)
    assert.ok(
      data.facilities.some(
        (facility) => facility.hotelId === hotel.id && facility.kind === 'breakfast_lounge',
      ),
    );
  unique(
    data.unitCosts.filter((cost) => cost.hotelId === hotel.id).map((cost) => cost.basis),
    `${hotel.id}: unit planning rates`,
  );
}
for (const room of data.rooms) {
  assert.equal(types.get(room.roomTypeId)?.hotelId, room.hotelId, `${room.id}: room-type hotel`);
  assert.equal(room.date, asOf);
  assert.equal(room.basis, 'scheduled');
}

// Selling quotes cover each type/date independently of booked nightly revenue.
assert.equal(data.roomRates.length, data.roomTypes.length * dates.length);
unique(
  data.roomRates.map((row) => `${row.roomTypeId}/${row.date}`),
  'Daily room-rate type/date quotes',
);
for (const rate of data.roomRates) {
  assert.equal(types.get(rate.roomTypeId)?.hotelId, rate.hotelId, 'Room-rate type/hotel key');
  assert.ok(dates.includes(rate.date), `Room-rate date ${rate.date} is in the covered quarter`);
  assert.equal(rate.currency, 'EUR');
  money(rate.nightlyRate, `${rate.roomTypeId}/${rate.date}: selling quote`);
  assert.ok(rate.nightlyRate >= 0.01 && rate.nightlyRate <= 10_000);
}
for (const type of data.roomTypes) {
  const rates = data.roomRates.filter((rate) => rate.roomTypeId === type.id);
  assert.deepEqual(rates.map((rate) => rate.date).sort(), dates, `${type.id}: full rate calendar`);
  assert.ok(
    new Set(rates.map((rate) => rate.nightlyRate)).size > 1,
    `${type.id}: dated quotes vary`,
  );
}

// The complete room-night ledger proves room occupancy and sold revenue independently.
unique(
  data.reservationNights.map((row) => `${row.roomId}/${row.date}`),
  'A physical room may be sold only once per stay date',
);
unique(
  data.reservationNights.map((row) => `${row.reservationId}/${row.date}`),
  'Reservation stay dates',
);
for (const night of data.reservationNights) {
  const reservation = reservations.get(night.reservationId);
  assert.ok(reservation, `${night.reservationId}: reservation foreign key`);
  assert.equal(reservation.roomId, night.roomId);
  assert.equal(reservation.hotelId, night.hotelId);
  assert.equal(reservation.channel, night.channel);
  assert.equal(rooms.get(night.roomId)?.hotelId, night.hotelId);
  assert.ok(
    dates.includes(night.date) &&
      night.date >= reservation.arrival &&
      night.date < reservation.departure,
    `${night.reservationId}/${night.date}: occupied date is inside the stay`,
  );
  assert.ok(
    !['cancelled', 'pending', 'no_show'].includes(reservation.status),
    `${night.reservationId}: excluded reservation cannot create an accepted room night`,
  );
  money(night.roomRevenue, `${night.reservationId}/${night.date}`);
  assert.equal(
    cents(night.roomRevenue),
    cents(reservation.quotedNightlyRate),
    `${night.reservationId}/${night.date}: accepted nightly quote`,
  );
}
for (const reservation of data.reservations) {
  assert.equal(types.get(reservation.roomTypeId)?.hotelId, reservation.hotelId);
  assert.ok(
    validDate(reservation.arrival) &&
      validDate(reservation.departure) &&
      reservation.arrival < reservation.departure,
  );
  assert.ok(
    validDate(reservation.bookedOn) &&
      reservation.bookedOn <= reservation.arrival &&
      reservation.bookedOn <= asOf,
    `${reservation.id}: booking creation chronology`,
  );
  const stayDates = datesBetween(reservation.arrival, reservation.departure);
  assert.ok(
    stayDates.length >= 1 && stayDates.length <= 4,
    `${reservation.id}: stays contain one to four nights`,
  );
  assert.equal(
    cents(reservation.quotedRevenue),
    cents(reservation.quotedNightlyRate) * stayDates.length,
    `${reservation.id}: full quoted stay value`,
  );
  if (reservation.cancelledOn !== null) {
    assert.ok(
      validDate(reservation.cancelledOn) &&
        reservation.cancelledOn >= reservation.bookedOn &&
        reservation.cancelledOn <= asOf,
    );
    assert.equal(reservation.status, 'cancelled');
  }
  if (reservation.status === 'cancelled') assert.ok(reservation.cancelledOn);
  const type = types.get(reservation.roomTypeId)!;
  assert.ok(reservation.adults <= type.maxAdults && reservation.children <= type.maxChildren);
  if (reservation.roomId !== null) {
    assert.equal(
      rooms.get(reservation.roomId)?.hotelId,
      reservation.hotelId,
      `${reservation.id}: assigned-room hotel foreign key`,
    );
    assert.equal(
      rooms.get(reservation.roomId)?.roomTypeId,
      reservation.roomTypeId,
      `${reservation.id}: assigned-room type foreign key`,
    );
  }
  const nights = nightsByReservation.get(reservation.id) ?? [];
  if (['cancelled', 'pending', 'no_show'].includes(reservation.status)) {
    assert.equal(nights.length, 0);
    assert.equal(reservation.roomRevenue, 0);
  } else {
    assert.ok(
      reservation.roomId && rooms.has(reservation.roomId),
      `${reservation.id}: accepted booking requires an assigned room`,
    );
    assert.equal(rooms.get(reservation.roomId)!.roomTypeId, reservation.roomTypeId);
    const expected = datesBetween(reservation.arrival, reservation.departure);
    assert.ok(
      expected.length >= 1 && expected.length <= 4,
      `${reservation.id}: stays contain one to four nights`,
    );
    assert.ok(
      expected.every((date) => dates.includes(date)),
      `${reservation.id}: complete stay is inside the reporting quarter`,
    );
    assert.deepEqual(
      nights.map((night) => night.date).sort(),
      expected,
      `${reservation.id}: complete accepted stay ledger`,
    );
    assert.equal(
      cents(reservation.roomRevenue),
      sumCents(nights.map((night) => night.roomRevenue)),
      `${reservation.id}: booked stay value reconciles to all nights`,
    );
    if (reservation.status === 'checked_out') assert.ok(reservation.departure <= asOf);
    if (reservation.status === 'checked_in')
      assert.ok(reservation.arrival <= asOf && reservation.departure > asOf);
    if (reservation.status === 'confirmed') assert.ok(reservation.arrival >= asOf);
  }
  money(reservation.roomRevenue, reservation.id);
  money(reservation.quotedNightlyRate, `${reservation.id}: quoted nightly rate`);
  money(reservation.quotedRevenue, `${reservation.id}: quoted stay value`);
}

// Every room and every facility has an explicit row on every date, including zero use.
assert.equal(data.dailyRoomStates.length, data.rooms.length * dates.length);
unique(
  data.dailyRoomStates.map((row) => `${row.roomId}/${row.date}`),
  'Daily room states',
);
for (const row of data.dailyRoomStates) {
  assert.equal(rooms.get(row.roomId)?.hotelId, row.hotelId);
  assert.ok(dates.includes(row.date));
  assert.equal(row.basis, row.date < asOf ? 'actual' : 'scheduled');
  assert.ok(row.occupancy !== 'occupied' || row.housekeeping !== 'inspected');
  if (row.maintenance === 'none') assert.equal(row.maintenanceNote, null);
  else {
    assert.equal(row.occupancy, 'out_of_service');
    assert.ok(row.maintenanceNote?.trim());
  }
  if (row.occupancy === 'out_of_service') assert.ok(row.maintenance !== 'none');
  if (row.date === asOf) {
    const room = rooms.get(row.roomId)!;
    assert.deepEqual(
      [room.occupancy, room.housekeeping, room.maintenance, room.maintenanceNote],
      [row.occupancy, row.housekeeping, row.maintenance, row.maintenanceNote],
      `${row.roomId}: current snapshot is derived from daily states`,
    );
  }
}
for (const room of data.rooms)
  assert.equal(data.dailyRoomStates.filter((row) => row.roomId === room.id).length, dates.length);
assert.equal(data.dailyFacilityActivity.length, data.facilities.length * dates.length);
unique(
  data.dailyFacilityActivity.map((row) => `${row.facilityId}/${row.date}`),
  'Daily facility activity',
);
for (const row of data.dailyFacilityActivity) {
  const facility = facilities.get(row.facilityId);
  assert.ok(
    facility && facility.hotelId === row.hotelId,
    `${row.facilityId}: facility foreign key`,
  );
  assert.ok(dates.includes(row.date));
  assert.equal(row.basis, row.date < asOf ? 'actual' : 'planned');
  assert.ok(Number.isInteger(row.uses) && row.uses >= 0);
  money(row.revenue, `${row.facilityId}/${row.date}`);
  if (facility.kind === 'parking' && facility.capacity !== null)
    assert.ok(row.uses <= facility.capacity, `${row.facilityId}/${row.date}: parking inventory`);
}
for (const facility of data.facilities)
  assert.equal(
    data.dailyFacilityActivity.filter((row) => row.facilityId === facility.id).length,
    dates.length,
  );

assert.equal(data.dailyPerformance.length, data.hotels.length * dates.length);
unique(
  data.dailyPerformance.map((row) => `${row.hotelId}/${row.date}`),
  'Daily performance',
);
unique(
  data.dailyChannels.map((row) => `${row.hotelId}/${row.date}/${row.channel}`),
  'Daily channel coverage',
);
for (const hotel of data.hotels)
  for (const date of dates) {
    const key = `${hotel.id}/${date}`;
    const day = performanceByDay.get(key);
    assert.ok(day, `${key}: daily performance exists`);
    const states = statesByDay.get(key) ?? [];
    const nights = nightsByDay.get(key) ?? [];
    const activity = activityByDay.get(key) ?? [];
    const costs = costsByDay.get(key) ?? [];
    const channels = channelsByDay.get(key) ?? [];
    const actual = date < asOf;
    assert.equal(
      states.length,
      expectedInventory[hotel.id],
      `${key}: all physical rooms have a state`,
    );
    assert.deepEqual(
      new Set(states.filter((row) => row.occupancy === 'occupied').map((row) => row.roomId)),
      new Set(nights.map((row) => row.roomId)),
      `${key}: occupied rooms reconcile to the accepted ledger`,
    );
    assert.equal(day.basis, actual ? 'actual' : 'on_books');
    assert.equal(day.ancillaryBasis, actual ? 'actual' : 'planned');
    assert.equal(
      day.roomsAvailable,
      states.filter((row) => row.occupancy !== 'out_of_service').length,
    );
    assert.equal(day.soldNights, nights.length);
    assert.ok(day.soldNights <= day.roomsAvailable && day.budgetSoldNights <= day.roomsAvailable);
    assert.equal(
      cents(day.roomRevenue),
      sumCents(nights.map((row) => row.roomRevenue)),
      `${key}: daily room revenue`,
    );
    const restaurantActivity = activity.filter(
      (row) => facilities.get(row.facilityId)!.kind === 'restaurant',
    );
    assert.equal(
      cents(day.restaurantRevenue),
      sumCents(restaurantActivity.map((row) => row.revenue)),
      `${key}: restaurant revenue`,
    );
    assert.equal(day.restaurantCovers, sum(restaurantActivity.map((row) => row.uses)));
    assert.equal(
      cents(day.otherRevenue),
      sumCents(
        activity
          .filter((row) => facilities.get(row.facilityId)!.kind !== 'restaurant')
          .map((row) => row.revenue),
      ),
      `${key}: other facility revenue`,
    );
    assert.deepEqual(
      new Set(channels.map((row) => row.channel)),
      new Set(ENUM_OPTIONS.bookingChannel),
    );
    assert.equal(sum(channels.map((row) => row.soldNights)), nights.length);
    assert.equal(sumCents(channels.map((row) => row.grossRevenue)), cents(day.roomRevenue));
    for (const channel of channels) {
      assert.equal(channel.basis, actual ? 'actual' : 'on_books');
      const sold = nights.filter((night) => night.channel === channel.channel);
      assert.equal(channel.soldNights, sold.length);
      assert.equal(cents(channel.grossRevenue), sumCents(sold.map((night) => night.roomRevenue)));
      assert.equal(
        cents(channel.acquisitionCost),
        Math.round(
          (cents(channel.grossRevenue) * Math.round(channel.commissionRate * 10_000)) / 10_000,
        ),
        `${channel.id}: daily acquisition cost rounds from exact gross cents`,
      );
    }
    assert.ok(costs.length > 0, `${key}: daily operating costs exist`);
    for (const cost of costs) {
      assert.equal(cost.basis, actual ? 'actual' : 'planned');
      money(cost.amount, cost.id);
    }
    assert.equal(
      sumCents(
        costs.filter((cost) => cost.category === 'channel_commission').map((cost) => cost.amount),
      ),
      sumCents(channels.map((channel) => channel.acquisitionCost)),
      `${key}: acquisition expenses included exactly once`,
    );
    for (const [field, amount] of Object.entries({
      roomRevenue: day.roomRevenue,
      restaurantRevenue: day.restaurantRevenue,
      otherRevenue: day.otherRevenue,
      budgetRoomRevenue: day.budgetRoomRevenue,
    }))
      money(amount, `${key}/${field}`);
  }

// Monthly ledgers are exact groups of their daily source rows, separated by basis.
const monthlyCostGroups = groupBy(
  data.dailyCosts,
  (row) => `${row.hotelId}/${row.date.slice(0, 7)}/${row.basis}/${row.category}/${row.department}`,
);
unique(
  data.costs.map(
    (row) => `${row.hotelId}/${row.period}/${row.basis}/${row.category}/${row.department}`,
  ),
  'Monthly cost lines',
);
assert.equal(
  data.costs.length,
  monthlyCostGroups.size,
  'Monthly costs contain exactly every daily-ledger group',
);
for (const cost of data.costs) {
  const key = `${cost.hotelId}/${cost.period}/${cost.basis}/${cost.category}/${cost.department}`;
  assert.ok(monthlyCostGroups.has(key), `${key}: monthly cost source`);
  assert.equal(
    cents(cost.amount),
    sumCents(monthlyCostGroups.get(key)!.map((row) => row.amount)),
    `${key}: monthly cost cents`,
  );
}
const monthlyChannelGroups = groupBy(
  data.dailyChannels,
  (row) => `${row.hotelId}/${row.date.slice(0, 7)}/${row.basis}/${row.channel}`,
);
unique(
  data.channels.map((row) => `${row.hotelId}/${row.period}/${row.basis}/${row.channel}`),
  'Monthly channel groups',
);
assert.equal(data.channels.length, monthlyChannelGroups.size);
for (const channel of data.channels) {
  const key = `${channel.hotelId}/${channel.period}/${channel.basis}/${channel.channel}`;
  const rows = monthlyChannelGroups.get(key);
  assert.ok(rows, `${key}: monthly channel source`);
  assert.equal(channel.soldNights, sum(rows.map((row) => row.soldNights)));
  assert.equal(cents(channel.grossRevenue), sumCents(rows.map((row) => row.grossRevenue)));
  assert.equal(cents(channel.acquisitionCost), sumCents(rows.map((row) => row.acquisitionCost)));
}

// Financial summaries use completed dates only. Planned expenses never become actual profit.
for (const scope of scopes)
  for (const period of REPORTING_PERIODS) {
    const inScope = (row: { hotelId: string }): boolean =>
      scope === 'portfolio' || row.hotelId === scope;
    const daily = data.dailyPerformance.filter(
      (row) => inScope(row) && row.date.startsWith(period.key) && row.basis === 'actual',
    );
    const costs = data.dailyCosts.filter(
      (row) => inScope(row) && row.date.startsWith(period.key) && row.basis === 'actual',
    );
    const channels = data.dailyChannels.filter(
      (row) => inScope(row) && row.date.startsWith(period.key) && row.basis === 'actual',
    );
    const inventory = data.rooms.filter(inScope);
    const summary = hotelSummary(scope, period.key);
    const roomRevenue = sumCents(daily.map((row) => row.roomRevenue));
    const restaurantRevenue = sumCents(daily.map((row) => row.restaurantRevenue));
    const otherRevenue = sumCents(daily.map((row) => row.otherRevenue));
    const sold = sum(daily.map((row) => row.soldNights));
    const available = sum(daily.map((row) => row.roomsAvailable));
    const costTotal = sumCents(costs.map((row) => row.amount));
    const actualDays = dates.filter((date) => date.startsWith(period.key) && date < asOf).length;
    assert.equal(summary.month, period.key);
    assert.equal(summary.actualDays, actualDays);
    assert.equal(summary.hasActuals, actualDays > 0);
    assert.equal(summary.hotelCount, scope === 'portfolio' ? data.hotels.length : 1);
    assert.equal(
      summary.guestCapacity,
      sum(
        inventory.map((room) => {
          const type = types.get(room.roomTypeId)!;
          return type.maxAdults + type.maxChildren;
        }),
      ),
    );
    assert.equal(summary.roomCount, inventory.length);
    assert.equal(summary.restaurantCovers, sum(daily.map((row) => row.restaurantCovers)));
    assert.deepEqual(
      new Set(hotelInventory(scope).map((room) => room.id)),
      new Set(inventory.map((room) => room.id)),
    );
    assert.equal(summary.roomsAvailable, available);
    assert.equal(summary.soldNights, sold);
    assert.equal(cents(summary.roomRevenue), roomRevenue);
    assert.equal(cents(summary.restaurantRevenue), restaurantRevenue);
    assert.equal(cents(summary.otherRevenue), otherRevenue);
    assert.equal(cents(summary.totalRevenue), roomRevenue + restaurantRevenue + otherRevenue);
    assert.equal(cents(summary.totalCosts), costTotal);
    assert.equal(
      cents(summary.operatingProfit),
      roomRevenue + restaurantRevenue + otherRevenue - costTotal,
    );
    assert.equal(summary.occupancy, percent(sold, available));
    assert.equal(cents(summary.adr), rateCents(roomRevenue, sold));
    assert.equal(cents(summary.revpar), rateCents(roomRevenue, available));
    assert.equal(
      summary.budgetOccupancy,
      percent(sum(daily.map((row) => row.budgetSoldNights)), available),
    );
    for (const [field, counts] of [
      ['occupancy', summary.roomStateCounts],
      ['housekeeping', summary.housekeepingCounts],
      ['maintenance', summary.maintenanceCounts],
    ] as const) {
      for (const [state, count] of Object.entries(counts))
        assert.equal(
          count,
          inventory.filter((room) => room[field] === state).length,
          `${scope}/${period.key}: ${field}/${state}`,
        );
      assert.equal(sum(Object.values(counts)), inventory.length);
    }
    assert.equal(
      cents(summary.budgetRoomRevenue),
      sumCents(daily.map((row) => row.budgetRoomRevenue)),
    );
    assert.equal(sumCents(costTotals(scope, period.key).map((row) => row.amount)), costTotal);
    const channelRows = channelSummary(scope, period.key, 'actual');
    assert.equal(sum(channelRows.map((row) => row.soldNights)), sold);
    assert.equal(sumCents(channelRows.map((row) => row.grossRevenue)), roomRevenue);
    assert.equal(
      sumCents(channelRows.map((row) => row.acquisitionCost)),
      sumCents(channels.map((row) => row.acquisitionCost)),
    );
    for (const channel of channelRows) {
      const input = channels.filter((row) => row.channel === channel.channel);
      const gross = sumCents(input.map((row) => row.grossRevenue));
      const acquisition = sumCents(input.map((row) => row.acquisitionCost));
      assert.equal(cents(channel.netRevenue), gross - acquisition);
      assert.equal(cents(channel.netAdr), rateCents(gross - acquisition, channel.soldNights));
      assert.equal(channel.share, percent(channel.soldNights, sold));
    }
    const trend = dailyTrend(scope, period.key);
    assert.equal(trend.length, period.days);
    for (const day of trend) {
      const input = data.dailyPerformance.filter((row) => inScope(row) && row.date === day.date);
      assert.equal(day.soldNights, sum(input.map((row) => row.soldNights)));
      assert.equal(cents(day.roomRevenue), sumCents(input.map((row) => row.roomRevenue)));
      assert.equal(
        cents(day.restaurantRevenue),
        sumCents(input.map((row) => row.restaurantRevenue)),
      );
      assert.equal(cents(day.otherRevenue), sumCents(input.map((row) => row.otherRevenue)));
      assert.equal(day.roomsAvailable, sum(input.map((row) => row.roomsAvailable)));
      assert.equal(day.basis, day.date < asOf ? 'actual' : 'on_books');
      assert.equal(day.ancillaryBasis, day.date < asOf ? 'actual' : 'planned');
    }
    for (const basis of ['planned', 'all'] as const) {
      const input = data.dailyCosts.filter(
        (row) =>
          inScope(row) &&
          row.date.startsWith(period.key) &&
          (basis === 'all' || row.basis === basis),
      );
      const totals = costTotals(scope, period.key, basis);
      assert.equal(
        sumCents(totals.map((row) => row.amount)),
        sumCents(input.map((row) => row.amount)),
        `${scope}/${period.key}/${basis}: selected expense basis`,
      );
      for (const category of ENUM_OPTIONS.costCategory)
        assert.equal(
          cents(totals.find((row) => row.category === category)?.amount ?? 0),
          sumCents(input.filter((row) => row.category === category).map((row) => row.amount)),
        );
    }
    for (const basis of ['on_books', 'all'] as const) {
      const input = data.dailyChannels.filter(
        (row) =>
          inScope(row) &&
          row.date.startsWith(period.key) &&
          (basis === 'all' || row.basis === basis),
      );
      const totalNights = sum(input.map((row) => row.soldNights));
      const totals = channelSummary(scope, period.key, basis);
      for (const total of totals) {
        const rows = input.filter((row) => row.channel === total.channel);
        const gross = sumCents(rows.map((row) => row.grossRevenue));
        const acquisition = sumCents(rows.map((row) => row.acquisitionCost));
        assert.equal(total.soldNights, sum(rows.map((row) => row.soldNights)));
        assert.equal(cents(total.grossRevenue), gross);
        assert.equal(cents(total.acquisitionCost), acquisition);
        assert.equal(cents(total.netRevenue), gross - acquisition);
        assert.equal(cents(total.netAdr), rateCents(gross - acquisition, total.soldNights));
        assert.equal(total.share, percent(total.soldNights, totalNights));
      }
    }
    for (const value of Object.values(summary))
      if (typeof value === 'number')
        assert.ok(Number.isFinite(value), `${scope}/${period.key}: finite financial summary`);
  }

for (const scope of scopes)
  for (const date of dates) {
    const inventory = hotelInventory(scope, date);
    const states = data.dailyRoomStates.filter(
      (row) => (scope === 'portfolio' || row.hotelId === scope) && row.date === date,
    );
    assert.equal(inventory.length, states.length);
    const expected = new Map(states.map((row) => [row.roomId, row]));
    for (const room of inventory) {
      const state = expected.get(room.id)!;
      assert.deepEqual(
        [
          room.date,
          room.basis,
          room.occupancy,
          room.housekeeping,
          room.maintenance,
          room.maintenanceNote,
        ],
        [
          state.date,
          state.basis,
          state.occupancy,
          state.housekeeping,
          state.maintenance,
          state.maintenanceNote,
        ],
        `${room.id}/${date}: dated inventory selector`,
      );
    }
  }
const monetaryValues = [
  ...data.roomTypes.map((row) => row.baseRate),
  ...data.facilities.map((row) => row.fee),
  ...data.restaurants.flatMap((row) => [row.breakfastPrice, row.averageCheck]),
  ...data.unitCosts.map((row) => row.amount),
  ...data.costs.map((row) => row.amount),
  ...data.dailyChannels.flatMap((row) => [row.grossRevenue, row.acquisitionCost]),
  ...data.channels.flatMap((row) => [row.grossRevenue, row.acquisitionCost]),
];
for (const value of monetaryValues) money(value, 'Reference and grouped financial values');
for (const scope of scopes)
  assert.deepEqual(
    hotelSummary(scope),
    hotelSummary(scope, '2026-11'),
    `${scope}: default financial month`,
  );
validateBookingFixtures();
validateEventFixtures();
console.log(
  `Validated ${data.hotels.length} hotels, ${data.rooms.length} rooms, ${dates.length} complete dates, ${data.reservationNights.length} accepted room nights, and all quarter ledgers against schema and independent reconciliation.`,
);
