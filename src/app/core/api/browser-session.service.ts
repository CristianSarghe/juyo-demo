import { Injectable, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { API_CONFIG } from './api.config';

/** An opaque API session only; user profiles and passwords are never persisted here. */
@Injectable({ providedIn: 'root' })
export class BrowserSessionService {
  private readonly config = inject(API_CONFIG);
  private readonly key = `juyo.api.session.v1:${encodeURIComponent(this.config.baseUrl.replace(/\/$/, ''))}`;
  private readonly state = signal<string | null>(this.restore());
  private readonly invalidation = new Subject<void>();
  readonly token = this.state.asReadonly();
  readonly invalidated = this.invalidation.asObservable();

  private restore(): string | null {
    if (this.config.mode !== 'http') return null;
    for (const persistent of [false, true]) {
      try {
        const token = this.storage(persistent)?.getItem(this.key);
        if (this.valid(token)) return token;
      } catch {
        // Storage restrictions must not prevent signing in for this visit.
      }
    }
    return null;
  }

  set(token: string, remember: boolean): void {
    if (this.config.mode !== 'http') return;
    if (!this.valid(token)) throw new Error('The API returned an invalid session token.');
    this.removeStored();
    this.state.set(token);
    try {
      this.storage(remember)?.setItem(this.key, token);
    } catch {
      // A valid session continues in memory when browser storage is unavailable.
    }
  }

  /** A delayed 401 from an earlier session must not erase a newer sign-in. */
  invalidate(expectedToken: string): void {
    if (this.token() !== expectedToken) return;
    this.clear();
    this.invalidation.next();
  }

  clear(): void {
    this.state.set(null);
    this.removeStored();
  }

  private valid(value: unknown): value is string {
    return (
      typeof value === 'string' && value.length <= 8192 && /^[A-Za-z0-9._~+/-]+=*$/.test(value)
    );
  }
  private storage(persistent: boolean): Storage | undefined {
    return persistent ? globalThis.localStorage : globalThis.sessionStorage;
  }
  private removeStored(): void {
    for (const persistent of [false, true]) {
      try {
        this.storage(persistent)?.removeItem(this.key);
      } catch {
        // Clear in-memory authorization even when persisted storage is blocked.
      }
    }
  }
}
