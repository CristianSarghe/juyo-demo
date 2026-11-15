/** Fixture-bound adapters for offline domain verification and mock handlers only. */
import { NETWORK_DATA } from '../../network.data';
import { createBookingRateHistory } from '../../room-price-history';
import { createEventRateContext } from '../../event-rate-plan.service';
import { buildNetworkSchema } from '../../network.schema';
export { aggregateBookingRateHistory } from '../../room-price-history';
export { suggestEventRate } from '../../event-rate-plan.service';
export const bookingRateHistory = createBookingRateHistory(NETWORK_DATA);
export const eventRateContext = createEventRateContext(NETWORK_DATA);
export const { dataDictionary: DATA_DICTIONARY, enumDictionary: ENUM_DICTIONARY } =
  buildNetworkSchema(NETWORK_DATA);
