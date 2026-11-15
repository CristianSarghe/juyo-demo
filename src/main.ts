import { bootstrapApplication } from '@angular/platform-browser';
import {
  provideRouter,
  withComponentInputBinding,
  withDisabledInitialNavigation,
} from '@angular/router';
import { AppComponent } from './app/app.component';
import { routes } from './app/app.routes';
import { provideTaiga, tuiIconsProvider } from '@taiga-ui/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { mockApiInterceptor } from './app/core/api/mock-api.interceptor';
import { API_CONFIG } from './app/core/api/api.config';
import { environment } from './environments/environment';

bootstrapApplication(AppComponent, {
  providers: [
    { provide: API_CONFIG, useValue: environment.api },
    provideHttpClient(withInterceptors([mockApiInterceptor])),
    provideRouter(routes, withComponentInputBinding(), withDisabledInitialNavigation()),
    provideTaiga({ mode: 'light', scrollbars: 'native', apis: 'stable' }),
    // Purpose-drawn, inline glyphs keep dropdowns local and avoid an external icon pack.
    tuiIconsProvider({
      '@tui.check':
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="m3 8 3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
      '@tui.x':
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="m4 4 8 8m0-8-8 8" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    }),
  ],
}).catch((error: unknown) => console.error('Unable to start Kassandra', error));
