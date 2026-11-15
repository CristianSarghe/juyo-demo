import type { BookingRateHistoryDay } from '../core/room-price-history';
import type { RoomRateDay } from '../core/room-rate.service';

export type RoomPriceTooltipRow = BookingRateHistoryDay &
  Pick<RoomRateDay, 'availableRooms' | 'sellableRooms' | 'heldRooms'>;

export interface RoomPriceTooltipContext {
  readonly today: boolean;
  readonly outside: boolean;
  readonly detailed: boolean;
}

const currency = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const fullDate = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' });
const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );

/** All prices come from accepted bookings; availability is one shared room-type inventory. */
export function formatPriceTooltip(
  row: RoomPriceTooltipRow,
  context: RoomPriceTooltipContext,
): string {
  const date = new Date(`${row.date}T12:00:00Z`);
  const dateText = Number.isFinite(date.getTime()) ? fullDate.format(date) : row.date;
  const dayText = Number.isFinite(date.getTime()) ? weekday.format(date) : '';
  const largestCount = Math.max(1, ...row.priceBuckets.map((price) => price.roomNights));
  const priceRows = row.priceBuckets
    .map(
      (price) => `<tr>
        <th scope="row">${escapeHtml(currency.format(price.nightlyRate))}</th>
        <td><span class="juyo-price-tooltip__volume">
          <span class="juyo-price-tooltip__track" aria-hidden="true"><span style="width:${Math.max(0, Math.min(100, (price.roomNights / largestCount) * 100))}%"></span></span>
          <strong>${escapeHtml(String(price.roomNights))}</strong>
        </span></td>
      </tr>`,
    )
    .join('');

  return `<section class="juyo-price-tooltip${context.detailed ? '' : ' juyo-price-tooltip--compact'}" role="tooltip" aria-label="Booking prices for ${escapeHtml(dateText)}">
    <header class="juyo-price-tooltip__heading">
      <div><h4>${escapeHtml(dateText)}</h4><p>${escapeHtml(dayText)}</p></div>
      <div class="juyo-price-tooltip__status">
        ${context.today ? '<span class="juyo-price-tooltip__today">Today</span>' : ''}
        ${context.outside ? '<span class="juyo-price-tooltip__outside">Outside interval</span>' : ''}
      </div>
    </header>
    <dl class="juyo-price-tooltip__summary">
      <div class="juyo-price-tooltip__average"><dt>Average booked price</dt><dd>${row.weightedRate === null ? '—' : escapeHtml(currency.format(row.weightedRate))}</dd></div>
      <div class="juyo-price-tooltip__availability"><dt>Free rooms</dt><dd>${escapeHtml(String(row.availableRooms))}<small> / ${escapeHtml(String(row.sellableRooms))}</small></dd><span>Shared across prices</span>${row.heldRooms ? `<small class="juyo-price-tooltip__held">${escapeHtml(String(row.heldRooms))} reserved manually</small>` : ''}</div>
    </dl>
    ${
      context.detailed
        ? `<div class="juyo-price-tooltip__prices">
      <table aria-label="Nightly booked prices and booking counts">
        <thead><tr><th scope="col">Nightly price</th><th scope="col">Bookings</th></tr></thead>
        <tbody>${priceRows || '<tr><td colspan="2" class="juyo-price-tooltip__empty">No bookings for this date</td></tr>'}</tbody>
      </table>
    </div>`
        : ''
    }
    <footer class="juyo-price-tooltip__total">${context.detailed ? `<span>Total bookings</span><strong>${escapeHtml(String(row.bookedRoomNights))}</strong>` : `<span><strong>${escapeHtml(String(row.bookedRoomNights))}</strong> bookings</span><span>Click for prices</span>`}</footer>
  </section>`;
}
