import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, DefaultUrlSerializer, Router, convertToParamMap } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../core/auth.service';
import { LoginComponent } from './login.component';

describe('LoginComponent logic', () => {
  let auth: {
    isAuthenticated: ReturnType<typeof signal<boolean>>;
    login: ReturnType<typeof vi.fn>;
  };
  let navigate: ReturnType<typeof vi.fn>;
  let route: { snapshot: { queryParamMap: ReturnType<typeof convertToParamMap> } };

  beforeEach(() => {
    auth = { isAuthenticated: signal(false), login: vi.fn().mockResolvedValue(undefined) };
    navigate = vi.fn().mockResolvedValue(true);
    const serializer = new DefaultUrlSerializer();
    route = { snapshot: { queryParamMap: convertToParamMap({}) } };
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: auth },
        {
          provide: Router,
          useValue: {
            navigateByUrl: navigate,
            parseUrl: (url: string) => serializer.parse(url),
            serializeUrl: (tree: Parameters<typeof serializer.serialize>[0]) =>
              serializer.serialize(tree),
          },
        },
        { provide: ActivatedRoute, useValue: route },
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
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/', { replaceUrl: true });
    expect(login.errors()).toEqual({});
    expect(login.pending()).toBe(false);
  });

  it('resumes an internal pricing deep link after sign-in', async () => {
    const target = '/rooms/prices?type=classic&from=2026-11-19#daily';
    route.snapshot.queryParamMap = convertToParamMap({ returnUrl: target });
    const login = TestBed.createComponent(LoginComponent).componentInstance;
    login.email = 'alex@juyo.local';
    login.password = 'juyo-demo';
    await login.signIn();
    expect(navigate).toHaveBeenCalledExactlyOnceWith(target, { replaceUrl: true });
  });

  it('uses the dashboard instead of an external or looping return destination', async () => {
    route.snapshot.queryParamMap = convertToParamMap({ returnUrl: '//unrelated.example/rooms' });
    auth.isAuthenticated.set(true);
    const login = TestBed.createComponent(LoginComponent).componentInstance;
    await login.signIn();
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/', { replaceUrl: true });
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
