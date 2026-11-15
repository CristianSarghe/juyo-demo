import { InjectionToken } from '@angular/core';

export interface ApiConfig {
  readonly mode: 'mock' | 'http';
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly mockLatencyMs: number;
}

/** Optional local fixture adapter. No feature service depends on this provider. */
export const MOCK_API_CONFIG: ApiConfig = {
  mode: 'mock',
  baseUrl: '/api/v1',
  timeoutMs: 15_000,
  mockLatencyMs: 40,
};
export const HTTP_API_CONFIG: ApiConfig = {
  mode: 'http',
  baseUrl: 'https://api-juyo.cristiansarghe.com/api/v1',
  timeoutMs: 30_000,
  mockLatencyMs: 0,
};
export const API_CONFIG = new InjectionToken<ApiConfig>('Juyo API configuration', {
  providedIn: 'root',
  factory: () => HTTP_API_CONFIG,
});
