import { Inject, Injectable } from '@angular/core';
import { AppUiStore } from './app-ui.store';

/** One validated hotel context shared by the shell, network views and chat. */
@Injectable({ providedIn: 'root' })
export class HotelScopeService {
  constructor(@Inject(AppUiStore) private readonly state: AppUiStore) {}

  get scope() {
    return this.state.hotelScope;
  }

  select(value: string): boolean {
    return this.state.selectHotel(value);
  }
}
