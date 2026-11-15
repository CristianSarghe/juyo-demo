/** Fixture-bound adapters for mock handlers and offline verification only. */
import { NETWORK_DATA } from '../../network.data';
import { createNetworkSelectors } from '../../network.selectors';
export { COST_LABELS, CHANNEL_LABELS } from '../../network.selectors';
export type { CostTotal, ChannelSummary, BookingSourceSummary } from '../../network.selectors';
export const {
  validateDateRange,
  hotelInventory,
  roomWarnings,
  upcomingEvents,
  costTotals,
  dailyTrend,
  channelSummary,
  bookingSources,
  hotelSummary,
  bookingPace,
  hotelDaySummary,
  bookingChartContext,
  bookingOutlook,
} = createNetworkSelectors(NETWORK_DATA);
