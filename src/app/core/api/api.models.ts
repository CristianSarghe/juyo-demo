import type {
  BookingSnapshot,
  Hotel,
  HotelNetwork,
  NetworkMeta,
  ReportingPeriod,
} from '../network.models';
import type { NetworkSchemaDescription } from '../network.schema';
import type { User } from '../models';

export interface SessionDto {
  readonly user: User;
  /** Required in HTTP mode. The optional local mock manages its own session. */
  readonly token?: string;
}

export interface ReferenceDataDto {
  readonly meta: NetworkMeta;
  readonly bookingSnapshot: BookingSnapshot;
  readonly hotels: Hotel[];
  readonly reportingPeriods: ReportingPeriod[];
  readonly dates: string[];
}
export interface Page<T> {
  readonly items: T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}
export interface ApiProblem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly code: string;
  readonly errors?: Readonly<Record<string, string>>;
}
export type CollectionKey = {
  [K in keyof HotelNetwork]: HotelNetwork[K] extends unknown[] ? K : never;
}[keyof HotelNetwork];
export type CollectionItem<K extends CollectionKey> = HotelNetwork[K][number];
export type IdentifiedCollectionKey = {
  [K in CollectionKey]: CollectionItem<K> extends { id: string } ? K : never;
}[CollectionKey];
export type ApiQuery = Readonly<Record<string, string | number | boolean | undefined | null>>;
export type SchemaDto = NetworkSchemaDescription;
