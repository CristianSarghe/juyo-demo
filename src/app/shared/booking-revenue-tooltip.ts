import type { BookingPaceDay } from '../core/network.models';

const currency = new Intl.NumberFormat('en-IE', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const fullDate = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );
const money = (value: number): string => escapeHtml(currency.format(value));

/** One stay date, using the same secured room/revenue facts as the overview bars. */
export function formatRevenueTooltip(row: BookingPaceDay): string {
  const date = new Date(`${row.date}T12:00:00Z`);
  const validDate = Number.isFinite(date.getTime());
  const dateText = validDate ? fullDate.format(date) : row.date;
  const past = row.state === 'past';
  const occupancy =
    row.roomsAvailable > 0 ? `${((row.securedRooms / row.roomsAvailable) * 100).toFixed(1)}%` : '—';
  return `<section class="juyo-revenue-tooltip" role="tooltip" aria-label="Revenue for ${escapeHtml(dateText)}">
    <header class="juyo-revenue-tooltip__heading">
      <h4>${escapeHtml(dateText)}</h4>
      ${row.state === 'today' ? '<span class="juyo-revenue-tooltip__today">Today</span>' : ''}
    </header>
    <dl class="juyo-revenue-tooltip__summary">
      <div class="juyo-revenue-tooltip__revenue"><dt>${past ? 'Earned revenue' : 'On the books'}</dt><dd>${money(row.securedRevenue)}</dd></div>
      <div class="juyo-revenue-tooltip__occupancy"><dt>${past ? 'Occupancy' : 'Booked occupancy'}</dt><dd>${occupancy}</dd></div>
    </dl>
    <footer class="juyo-revenue-tooltip__footer">Click to view day</footer>
  </section>`;
}
