import type { ReferenceDataDto } from '../app/core/api/api.models';
import type { Hotel, HotelNetwork } from '../app/core/network.models';

/** Small, deterministic fixtures. Unit tests never load the production demo ledger. */
export const hotel: Hotel = {
  id: 'dev-ber',
  name: 'Spreehof Berlin',
  city: 'Berlin',
  country: 'Germany',
  countryCode: 'DE',
  timezone: 'Europe/Berlin',
  status: 'active',
  category: 'city',
  starRating: 4,
  openedYear: 2015,
  coordinates: { latitude: 52.52, longitude: 13.405 },
  address: { line1: 'Demo Street 10', postalCode: '10115' },
};

export const secondHotel: Hotel = {
  ...hotel,
  id: 'dev-ams',
  name: 'Canal House Amsterdam',
  city: 'Amsterdam',
  country: 'Netherlands',
  countryCode: 'NL',
  timezone: 'Europe/Amsterdam',
  coordinates: { latitude: 52.3676, longitude: 4.9041 },
};

export const reportingDates = Array.from({ length: 92 }, (_, index) =>
  new Date(Date.UTC(2026, 9, 1 + index)).toISOString().slice(0, 10),
);

export const referenceData: ReferenceDataDto = {
  meta: {
    id: 'test-organization',
    name: 'Test organization',
    schemaVersion: '1.0',
    testData: true,
    currency: 'EUR',
    amountBasis: 'net_excluding_vat',
    reportingPeriod: {
      startDate: '2026-10-01',
      endDate: '2026-12-31',
      days: 92,
      label: 'October–December 2026',
    },
    snapshotDate: '2026-11-14',
    notes: [],
  },
  bookingSnapshot: {
    asOf: '2026-11-14',
    previousAsOf: '2026-11-07',
    period: {
      startDate: '2026-11-01',
      endDate: '2026-11-30',
      days: 30,
      label: 'November 2026',
    },
    testData: true,
    source: 'unit-test',
    includedOnBooksStatuses: ['confirmed', 'checked_in'],
    excludedStatuses: ['cancelled', 'pending', 'no_show'],
    notes: [],
  },
  hotels: [hotel, secondHotel],
  reportingPeriods: [
    {
      key: '2026-10',
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      days: 31,
      label: 'October 2026',
    },
    {
      key: '2026-11',
      startDate: '2026-11-01',
      endDate: '2026-11-30',
      days: 30,
      label: 'November 2026',
    },
    {
      key: '2026-12',
      startDate: '2026-12-01',
      endDate: '2026-12-31',
      days: 31,
      label: 'December 2026',
    },
  ],
  dates: reportingDates,
};

/** Fresh mutable arrays for each test; shared reference fixtures remain read-only by convention. */
export function emptyNetworkData(): HotelNetwork {
  return {
    meta: structuredClone(referenceData.meta),
    bookingSnapshot: structuredClone(referenceData.bookingSnapshot),
    hotels: structuredClone(referenceData.hotels),
    reportingPeriods: structuredClone(referenceData.reportingPeriods),
    events: [],
    eventHotelImpacts: [],
    roomTypes: [],
    roomRates: [],
    rooms: [],
    facilities: [],
    restaurants: [],
    costs: [],
    unitCosts: [],
    channels: [],
    dailyPerformance: [],
    reservations: [],
    bookingPositions: [],
    dailyRoomStates: [],
    dailyCosts: [],
    dailyChannels: [],
    reservationNights: [],
    dailyFacilityActivity: [],
  };
}
