export const ENUM_OPTIONS = {
  hotelStatus: ['active', 'renovation', 'closed'],
  hotelCategory: ['business', 'boutique', 'city'],
  roomOccupancy: ['available', 'occupied', 'out_of_service'],
  housekeeping: ['clean', 'dirty', 'inspected'],
  maintenance: ['none', 'reported', 'in_progress'],
  roomFacility: [
    'wifi',
    'air_conditioning',
    'desk',
    'coffee_machine',
    'balcony',
    'accessible',
    'kitchenette',
    'bathtub',
  ],
  facilityKind: [
    'wifi',
    'parking',
    'gym',
    'meeting_room',
    'spa',
    'pool',
    'bar',
    'restaurant',
    'breakfast_lounge',
  ],
  feeUnit: ['included', 'per_hour', 'per_day', 'per_night', 'per_person'],
  costCategory: [
    'payroll',
    'utilities',
    'housekeeping',
    'maintenance',
    'admin',
    'rent',
    'food_beverage',
    'channel_commission',
    'marketing',
    'insurance',
  ],
  department: ['rooms', 'food_beverage', 'shared'],
  unitCostBasis: ['occupied_room', 'breakfast', 'staff_hour', 'parking_night'],
  bookingChannel: ['direct', 'ota', 'corporate', 'wholesale'],
  reservationStatus: ['confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show', 'pending'],
  bookingState: ['past', 'today', 'future'],
  roomStateBasis: ['actual', 'scheduled'],
  costBasis: ['actual', 'planned'],
  revenueBasis: ['actual', 'on_books'],
  activityBasis: ['actual', 'planned'],
  eventCategory: ['conference', 'trade_fair', 'concert', 'festival', 'market', 'sport'],
  eventImportance: ['mild', 'medium', 'important'],
  eventImpactSource: ['fixture', 'kassandra'],
} as const;

/** Backend identifiers/calendar values are validated against reference data, not fixture unions. */
export type ReportingMonth = string;
export interface DateRange {
  startDate: string;
  endDate: string;
}
export type BookingSelection = ReportingMonth | DateRange;
export interface ReportingPeriod {
  key: ReportingMonth;
  startDate: string;
  endDate: string;
  days: number;
  label: string;
}
export interface ReportingRange {
  startDate: string;
  endDate: string;
  days: number;
  label: string;
}
export interface BookingPeriod extends ReportingRange {
  key?: ReportingMonth;
}
export type HotelId = string;
export type PropertyScope = HotelId | 'portfolio';
export type EnumKey = keyof typeof ENUM_OPTIONS;
export type EnumValue<K extends EnumKey> = (typeof ENUM_OPTIONS)[K][number];
export type RoomOccupancy = EnumValue<'roomOccupancy'>;
export type HousekeepingState = EnumValue<'housekeeping'>;
export type MaintenanceState = EnumValue<'maintenance'>;
export type BookingChannel = EnumValue<'bookingChannel'>;
export type CostCategory = EnumValue<'costCategory'>;
export type EventImportance = EnumValue<'eventImportance'>;

export interface NetworkMeta {
  id: string;
  name: string;
  schemaVersion: string;
  testData: boolean;
  currency: 'EUR';
  amountBasis: 'net_excluding_vat';
  reportingPeriod: ReportingRange;
  snapshotDate: string;
  notes: string[];
}

export interface Geography {
  latitude: number;
  longitude: number;
}

/** Configured postal address; sample fixture addresses are not verified locations. */
export interface HotelAddress {
  line1: string;
  line2?: string | null;
  postalCode: string;
}

export interface Hotel {
  id: HotelId;
  name: string;
  city: string;
  country: string;
  countryCode: string;
  timezone: string;
  status: EnumValue<'hotelStatus'>;
  category: EnumValue<'hotelCategory'>;
  starRating: number;
  openedYear: number;
  coordinates: Geography;
  address?: HotelAddress | null;
}

export interface HotelEvent {
  id: string;
  name: string;
  category: EnumValue<'eventCategory'>;
  startDate: string;
  endDate: string;
  venue: string;
  city: string;
  country: string;
  coordinates: Geography;
  expectedAttendance: number;
}

export interface EventHotelImpact {
  eventId: string;
  hotelId: HotelId;
  importance: EventImportance;
  distanceKm: number;
  reason: string;
  source: EnumValue<'eventImpactSource'>;
  assessedAt: string;
}

export interface UpcomingHotelEvent {
  event: HotelEvent;
  impacts: (EventHotelImpact & { hotel: Hotel })[];
  importance: EventImportance;
}

export interface RoomWarning {
  room: Room;
  hotel: Hotel;
}

export interface RoomType {
  id: string;
  hotelId: HotelId;
  name: string;
  inventory: number;
  maxAdults: number;
  maxChildren: number;
  areaM2: number;
  baseRate: number;
  facilities: EnumValue<'roomFacility'>[];
}

/** Dated selling quote, independent of accepted reservation-night revenue. */
export interface RoomRate {
  hotelId: HotelId;
  roomTypeId: string;
  date: string;
  nightlyRate: number;
  currency: 'EUR';
}

export interface Room {
  id: string;
  hotelId: HotelId;
  roomTypeId: string;
  number: string;
  floor: number;
  occupancy: RoomOccupancy;
  housekeeping: HousekeepingState;
  maintenance: MaintenanceState;
  maintenanceNote: string | null;
  date: string;
  basis: EnumValue<'roomStateBasis'>;
}

export interface DailyRoomState {
  roomId: string;
  hotelId: HotelId;
  date: string;
  occupancy: RoomOccupancy;
  housekeeping: HousekeepingState;
  maintenance: MaintenanceState;
  maintenanceNote: string | null;
  basis: EnumValue<'roomStateBasis'>;
}

export interface Facility {
  id: string;
  hotelId: HotelId;
  kind: EnumValue<'facilityKind'>;
  name: string;
  capacity: number | null;
  openingHours: string;
  fee: number;
  feeUnit: EnumValue<'feeUnit'>;
}

export interface Restaurant {
  id: string;
  hotelId: HotelId;
  name: string;
  cuisine: string;
  seats: number;
  openingHours: string;
  breakfastPrice: number;
  averageCheck: number;
}

export interface MonthlyCost {
  id: string;
  hotelId: HotelId;
  period: ReportingMonth;
  category: CostCategory;
  department: EnumValue<'department'>;
  amount: number;
  description: string;
  basis: EnumValue<'costBasis'>;
}

export interface DailyCost extends Omit<MonthlyCost, 'period'> {
  date: string;
}

export interface UnitCost {
  id: string;
  hotelId: HotelId;
  basis: EnumValue<'unitCostBasis'>;
  amount: number;
  description: string;
}

export interface ChannelPerformance {
  id: string;
  hotelId: HotelId;
  period: ReportingMonth;
  channel: BookingChannel;
  soldNights: number;
  grossRevenue: number;
  commissionRate: number;
  acquisitionCost: number;
  basis: EnumValue<'revenueBasis'>;
}

export interface DailyChannel extends Omit<ChannelPerformance, 'period'> {
  date: string;
}

export interface DailyPerformance {
  hotelId: HotelId;
  date: string;
  roomsAvailable: number;
  soldNights: number;
  roomRevenue: number;
  restaurantRevenue: number;
  restaurantCovers: number;
  otherRevenue: number;
  budgetSoldNights: number;
  budgetRoomRevenue: number;
  basis: EnumValue<'revenueBasis'>;
  ancillaryBasis: EnumValue<'activityBasis'>;
}

export interface DailyFacilityActivity {
  hotelId: HotelId;
  facilityId: string;
  date: string;
  uses: number;
  revenue: number;
  basis: EnumValue<'activityBasis'>;
}

export interface Reservation {
  id: string;
  hotelId: HotelId;
  roomTypeId: string;
  roomId: string | null;
  guestRef: string;
  channel: BookingChannel;
  status: EnumValue<'reservationStatus'>;
  arrival: string;
  departure: string;
  adults: number;
  children: number;
  roomRevenue: number;
  currency: 'EUR';
  bookedOn: string;
  cancelledOn: string | null;
  quotedNightlyRate: number;
  quotedRevenue: number;
}

export interface ReservationNight {
  reservationId: string;
  hotelId: HotelId;
  roomId: string;
  date: string;
  channel: BookingChannel;
  roomRevenue: number;
}

export interface HotelNetwork {
  meta: NetworkMeta;
  bookingSnapshot: BookingSnapshot;
  hotels: Hotel[];
  events: HotelEvent[];
  eventHotelImpacts: EventHotelImpact[];
  roomTypes: RoomType[];
  roomRates: RoomRate[];
  rooms: Room[];
  facilities: Facility[];
  restaurants: Restaurant[];
  costs: MonthlyCost[];
  unitCosts: UnitCost[];
  channels: ChannelPerformance[];
  dailyPerformance: DailyPerformance[];
  reservations: Reservation[];
  bookingPositions: BookingPosition[];
  reportingPeriods: ReportingPeriod[];
  dailyRoomStates: DailyRoomState[];
  dailyCosts: DailyCost[];
  dailyChannels: DailyChannel[];
  reservationNights: ReservationNight[];
  dailyFacilityActivity: DailyFacilityActivity[];
}

export interface BookingSnapshot {
  asOf: string;
  previousAsOf: string;
  period: ReportingRange;
  testData: boolean;
  source: string;
  includedOnBooksStatuses: ('confirmed' | 'checked_in')[];
  excludedStatuses: ('cancelled' | 'pending' | 'no_show')[];
  notes: string[];
}

export interface BookingPosition {
  hotelId: HotelId;
  stayDate: string;
  capturedAsOf: string;
  state: EnumValue<'bookingState'>;
  roomsAvailable: number;
  actualRooms: number | null;
  actualRoomRevenue: number | null;
  roomsOnBooks: number | null;
  revenueOnBooks: number | null;
  roomsOnBooks7dAgo: number | null;
  revenueOnBooks7dAgo: number | null;
  pickup7dRoomNights: number | null;
  pickup7dRevenue: number | null;
  targetRooms: number;
  targetRevenue: number;
}

export interface BookingPaceDay {
  date: string;
  state: EnumValue<'bookingState'>;
  roomsAvailable: number;
  actualRooms: number;
  actualRevenue: number;
  onBooksRooms: number;
  onBooksRevenue: number;
  securedRooms: number;
  securedRevenue: number;
  targetRooms: number;
  targetRevenue: number;
  remainingTargetRooms: number;
  remainingTargetRevenue: number;
  pickup7dRooms: number;
  pickup7dRevenue: number;
}

export interface HotelDaySummary {
  date: string;
  basis: EnumValue<'roomStateBasis'>;
  physicalRooms: number;
  sellableRooms: number;
  occupiedRooms: number;
  roomsToSell: number;
  outOfOrderRooms: number;
  arrivals: number;
  departures: number;
  averageRate: number;
  roomRevenue: number;
  targetRevenue: number;
  occupancy: number;
}

export interface BookingChartContext {
  rows: BookingPaceDay[];
  range: DateRange;
  windowSize: number;
  startIndex: number;
  endIndex: number;
  scrollable: boolean;
}

export interface BookingOutlook {
  asOf: string;
  previousAsOf: string;
  period: BookingPeriod;
  realizedRevenue: number;
  onBooksRevenue: number;
  totalSecuredRevenue: number;
  targetRevenue: number;
  securedRooms: number;
  availableRooms: number;
  targetRooms: number;
  securedOccupancy: number;
  targetOccupancy: number;
  securedADR: number;
  targetADR: number;
  securedRevPAR: number;
  targetRevPAR: number;
  actualAvailableRooms: number;
  actualSoldRooms: number;
  futureAvailableRooms: number;
  futureBookedRooms: number;
  realizedOccupancy: number;
  onBooksOccupancy: number;
  realizedADR: number;
  onBooksADR: number;
  remainingRooms: number;
  remainingTargetRooms: number;
  remainingTargetRevenue: number;
  targetGapRevenue: number;
  sevenDayPickupRevenue: number;
  sevenDayPickupRooms: number;
  todayRevenue: number;
  todayRooms: number;
}

export interface HotelSummary {
  id: PropertyScope;
  name: string;
  hotelCount: number;
  roomCount: number;
  guestCapacity: number;
  roomsAvailable: number;
  soldNights: number;
  roomRevenue: number;
  restaurantRevenue: number;
  restaurantCovers: number;
  otherRevenue: number;
  totalRevenue: number;
  totalCosts: number;
  operatingProfit: number;
  occupancy: number;
  adr: number;
  revpar: number;
  budgetOccupancy: number;
  budgetRoomRevenue: number;
  roomStateCounts: Record<RoomOccupancy, number>;
  housekeepingCounts: Record<HousekeepingState, number>;
  maintenanceCounts: Record<MaintenanceState, number>;
  month: ReportingMonth;
  hasActuals: boolean;
  actualDays: number;
}
