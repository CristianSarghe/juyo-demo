import type { DateRange, PropertyScope } from '../network.models';

export type PageView = 'overview' | 'rooms' | 'reservations' | 'configuration';

/** Router-owned page + shared NgRx hotel/calendar context. No duplicated selection state. */
export interface PageRequest {
  readonly view: PageView;
  readonly scope: PropertyScope;
  readonly range: DateRange;
  readonly section?: 'inventory' | 'prices';
  readonly roomTypeId?: string;
  readonly eventId?: string;
}

/** Only filters relevant to a page participate in its identity. */
export function pageRequestKey(request: PageRequest): string {
  const prices = request.view === 'rooms' && request.section === 'prices';
  const dated = request.view === 'overview' || prices;
  return JSON.stringify([
    request.view,
    request.scope,
    request.view === 'rooms' ? (request.section ?? 'inventory') : null,
    dated ? request.range.startDate : null,
    dated ? request.range.endDate : null,
    prices ? (request.roomTypeId ?? null) : null,
  ]);
}
