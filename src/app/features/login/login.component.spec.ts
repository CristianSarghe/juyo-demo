import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../core/auth.service';
import { LoginComponent } from './login.component';

describe('LoginComponent logic', () => {
  let auth: {
    isAuthenticated: ReturnType<typeof signal<boolean>>;
    login: ReturnType<typeof vi.fn>;
  };
  let navigate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    auth = { isAuthenticated: signal(false), login: vi.fn().mockResolvedValue(undefined) };
    navigate = vi.fn().mockResolvedValue(true);
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: auth },
        { provide: Router, useValue: { navigateByUrl: navigate } },
      ],
    }).overrideComponent(LoginComponent, { set: { template: '', imports: [] } });
  });

  it('signs in with a trimmed email, opens the workspace and clears pending state', async () => {
    const login = TestBed.createComponent(LoginComponent).componentInstance;
    login.email = '  alex@juyo.local  ';
    login.password = 'juyo-demo';

    const pending = login.signIn();
    expect(login.pending()).toBe(true);
    await pending;

    expect(auth.login).toHaveBeenCalledExactlyOnceWith('alex@juyo.local', 'juyo-demo');
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/network');
    expect(login.errors()).toEqual({});
    expect(login.pending()).toBe(false);
  });

  it('validates the form before sending credentials', async () => {
    const login = TestBed.createComponent(LoginComponent).componentInstance;
    login.email = 'alex';
    login.password = 'short';
    await login.signIn();

    expect(login.errors()).toEqual({
      email: 'Enter a valid email.',
      password: 'Use at least 8 characters.',
    });
    expect(auth.login).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('lets an authenticated user retry opening the workspace without signing in again', async () => {
    auth.isAuthenticated.set(true);
    const login = TestBed.createComponent(LoginComponent).componentInstance;
    navigate.mockResolvedValueOnce(false);
    await login.signIn();
    expect(login.errors().form).toBe('Could not open the workspace. Try again.');

    await login.signIn();
    expect(login.errors()).toEqual({});
    expect(auth.login).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledTimes(2);
  });
});
