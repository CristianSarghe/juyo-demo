import type { CollectionKey } from './api.models';

export const RESOURCE_PATHS = {
  hotels: '/hotels',
  events: '/events',
  eventHotelImpacts: '/event-hotel-impacts',
  roomTypes: '/room-types',
  roomRates: '/room-rates',
  rooms: '/rooms',
  facilities: '/facilities',
  restaurants: '/restaurants',
  costs: '/costs',
  unitCosts: '/unit-costs',
  channels: '/analytics/channel-months',
  dailyPerformance: '/analytics/performance-days',
  reservations: '/reservations',
  bookingPositions: '/analytics/booking-positions',
  reportingPeriods: '/reporting-periods',
  dailyRoomStates: '/room-states',
  dailyCosts: '/cost-entries',
  dailyChannels: '/analytics/channel-days',
  reservationNights: '/reservation-nights',
  dailyFacilityActivity: '/facility-activity',
} as const satisfies Record<CollectionKey, string>;
