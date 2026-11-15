import { NETWORK_DATA as data, REPORTING_DATES } from '../src/app/core/network.data.ts';
import type { Geography, PropertyScope } from '../src/app/core/network.models.ts';
import { roomWarnings, upcomingEvents } from '../src/app/core/api/mock/fixture-selectors.ts';
import { assert, money, unique, validDate } from './validation-helpers.ts';

const importanceRank = { mild: 0, medium: 1, important: 2 } as const;
const cityCentres: Record<string, Geography> = {
  Brussels: { latitude: 50.8503, longitude: 4.3517 },
  Amsterdam: { latitude: 52.3676, longitude: 4.9041 },
  Berlin: { latitude: 52.52, longitude: 13.405 },
  Porto: { latitude: 41.1579, longitude: -8.6291 },
};

// Independent great-circle calculation, using the documented mean Earth radius.
function kilometres(from: Geography, to: Geography): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(to.latitude - from.latitude);
  const longitudeDelta = radians(to.longitude - from.longitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(from.latitude)) *
      Math.cos(radians(to.latitude)) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 12_742 * Math.asin(Math.sqrt(Math.min(1, haversine)));
}

function coordinates(value: Geography, context: string): void {
  assert.ok(
    Number.isFinite(value.latitude) && value.latitude >= -90 && value.latitude <= 90,
    `${context}: valid WGS84 latitude`,
  );
  assert.ok(
    Number.isFinite(value.longitude) && value.longitude >= -180 && value.longitude <= 180,
    `${context}: valid WGS84 longitude`,
  );
}

export function validateEventFixtures(): void {
  const hotels = new Map(data.hotels.map((hotel) => [hotel.id, hotel]));
  const events = new Map(data.events.map((event) => [event.id, event]));
  const scopes: PropertyScope[] = ['portfolio', ...data.hotels.map((hotel) => hotel.id)];
  const asOf = data.bookingSnapshot.asOf;
  assert.ok(
    data.events.length > 0 && data.eventHotelImpacts.length > 0,
    'Populated event fixtures',
  );
  unique(
    data.events.map((event) => event.id),
    'Event IDs',
  );
  unique(
    data.eventHotelImpacts.map((impact) => `${impact.eventId}/${impact.hotelId}`),
    'Hotel-event assessment pairs',
  );
  unique(
    data.hotels.map((hotel) => `${hotel.coordinates.latitude}/${hotel.coordinates.longitude}`),
    'Distinct property coordinates',
  );
  for (const hotel of data.hotels) {
    coordinates(hotel.coordinates, hotel.id);
    assert.ok(
      kilometres(hotel.coordinates, cityCentres[hotel.city]) < 20,
      `${hotel.id}: location is near its documented city`,
    );
    assert.ok(
      data.eventHotelImpacts.some((impact) => impact.hotelId === hotel.id),
      `${hotel.id}: populated hotel relevance assessments`,
    );
  }
  for (const event of data.events) {
    coordinates(event.coordinates, event.id);
    assert.ok(
      validDate(event.startDate) && validDate(event.endDate) && event.startDate <= event.endDate,
      `${event.id}: inclusive calendar dates are ordered`,
    );
    assert.ok(
      Number.isInteger(event.expectedAttendance) && event.expectedAttendance > 0,
      `${event.id}: positive illustrative attendance`,
    );
    assert.ok(
      data.eventHotelImpacts.some((impact) => impact.eventId === event.id),
      `${event.id}: no orphan event without a hotel assessment`,
    );
    for (const field of ['name', 'venue', 'city', 'country'] as const)
      assert.ok(event[field].trim().length > 0, `${event.id}: populated ${field}`);
  }
  for (const impact of data.eventHotelImpacts) {
    const event = events.get(impact.eventId);
    const hotel = hotels.get(impact.hotelId);
    assert.ok(event && hotel, `${impact.eventId}/${impact.hotelId}: valid foreign keys`);
    money(impact.distanceKm, `${impact.eventId}/${impact.hotelId}: rounded distance`);
    assert.equal(
      Math.round(impact.distanceKm * 100),
      Math.round(kilometres(hotel.coordinates, event.coordinates) * 100),
      `${impact.eventId}/${impact.hotelId}: Haversine distance reconciles to locations`,
    );
    assert.ok(impact.reason.trim().length > 0, `${impact.eventId}: hotel-specific rationale`);
    assert.equal(impact.source, 'fixture', `${impact.eventId}: seeded provenance is explicit`);
    assert.ok(
      validDate(impact.assessedAt) && impact.assessedAt <= asOf,
      `${impact.eventId}: assessment exists by the business date`,
    );
  }

  const shared = data.events.filter(
    (event) => data.eventHotelImpacts.filter((impact) => impact.eventId === event.id).length > 1,
  );
  assert.ok(shared.length > 0, 'A shared event exercises normalized portfolio deduplication');
  for (const event of shared) {
    const byDistance = data.eventHotelImpacts
      .filter((impact) => impact.eventId === event.id)
      .sort((a, b) => a.distanceKm - b.distanceKm);
    // The curated shared event has an indirect, distant itinerary link. No universal cutoff
    // is imposed on unrelated events, whose scale and audience can differ.
    assert.ok(
      importanceRank[byDistance[0].importance] >= importanceRank[byDistance.at(-1)!.importance],
      `${event.id}: its distant itinerary assessment cannot outrank the local assessment`,
    );
  }
  assert.ok(
    data.events.some((event) => event.startDate < asOf && event.endDate >= asOf),
    'An ongoing event exercises inclusive date filtering',
  );

  for (const scope of scopes) {
    for (const date of REPORTING_DATES) {
      const links = data.eventHotelImpacts.filter(
        (impact) => scope === 'portfolio' || impact.hotelId === scope,
      );
      const expectedIds = data.events
        .filter((event) => event.endDate >= date && links.some((link) => link.eventId === event.id))
        .map((event) => event.id)
        .sort();
      const rows = upcomingEvents(scope, date);
      unique(
        rows.map((row) => row.event.id),
        `${scope}/${date}: deduplicated event list`,
      );
      assert.deepEqual(
        rows.map((row) => row.event.id).sort(),
        expectedIds,
        `${scope}/${date}: exactly the relevant ongoing and upcoming events`,
      );
      for (const [index, row] of rows.entries()) {
        assert.deepEqual(row.event, events.get(row.event.id));
        const expectedLinks = links.filter((link) => link.eventId === row.event.id);
        assert.deepEqual(
          row.impacts.map((impact) => impact.hotelId).sort(),
          expectedLinks.map((impact) => impact.hotelId).sort(),
          `${scope}/${date}/${row.event.id}: hotel scope cannot leak irrelevant links`,
        );
        for (const impact of row.impacts) {
          const expected = expectedLinks.find((link) => link.hotelId === impact.hotelId)!;
          const { hotel, ...assessment } = impact;
          assert.deepEqual(assessment, expected);
          assert.deepEqual(hotel, hotels.get(impact.hotelId));
        }
        assert.equal(
          importanceRank[row.importance],
          Math.max(...expectedLinks.map((link) => importanceRank[link.importance])),
          `${scope}/${date}/${row.event.id}: displayed importance uses only relevant hotels`,
        );
        if (index > 0) {
          const previous = rows[index - 1].event;
          const ongoing = row.event.startDate <= date;
          const previousOngoing = previous.startDate <= date;
          assert.ok(
            Number(previousOngoing) > Number(ongoing) ||
              (previousOngoing === ongoing &&
                (previous.startDate < row.event.startDate ||
                  (previous.startDate === row.event.startDate &&
                    previous.name.localeCompare(row.event.name) <= 0))),
            `${scope}/${date}: ongoing first, then chronological event order`,
          );
        }
      }

      const expectedWarnings = data.dailyRoomStates.filter(
        (room) =>
          room.date === date &&
          room.occupancy === 'out_of_service' &&
          (scope === 'portfolio' || room.hotelId === scope),
      );
      const warnings = roomWarnings(scope, date);
      unique(
        warnings.map(({ room }) => room.id),
        `${scope}/${date}: unique room warnings`,
      );
      assert.deepEqual(
        warnings.map(({ room }) => room.id).sort(),
        expectedWarnings.map((room) => room.roomId).sort(),
        `${scope}/${date}: warnings match dated out-of-service inventory`,
      );
      for (const { room, hotel } of warnings) {
        const expected = expectedWarnings.find((state) => state.roomId === room.id)!;
        assert.equal(room.date, date);
        for (const field of [
          'hotelId',
          'basis',
          'occupancy',
          'housekeeping',
          'maintenance',
          'maintenanceNote',
        ] as const)
          assert.equal(room[field], expected[field]);
        assert.deepEqual(hotel, hotels.get(room.hotelId));
      }
    }
    assert.deepEqual(upcomingEvents(scope), upcomingEvents(scope, asOf));
    assert.deepEqual(roomWarnings(scope), roomWarnings(scope, asOf));
  }
  console.log(
    `Validated ${data.events.length} geolocated events, ${data.eventHotelImpacts.length} hotel assessments, and scoped event/warning selectors across all ${REPORTING_DATES.length} dates.`,
  );
}
