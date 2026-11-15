import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { SpinnerComponent } from '../../shared/spinner.component';
import { WorkspaceSkeletonComponent } from '../../shared/workspace-skeleton.component';

@Component({
  selector: 'app-login',
  imports: [FormsModule, SpinnerComponent, WorkspaceSkeletonComponent],
  templateUrl: './login.component.html',
  styleUrl: './login.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginComponent {
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  @ViewChild('emailField') private emailField?: ElementRef<HTMLInputElement>;
  @ViewChild('passwordField') private passwordField?: ElementRef<HTMLInputElement>;

  email = '';
  password = '';
  readonly showPassword = signal(false);
  readonly pending = signal(false);
  readonly errors = signal<{ email?: string; password?: string; form?: string }>({});

  async signIn(): Promise<void> {
    if (this.pending()) return;
    const errors: { email?: string; password?: string } = {};
    if (!this.auth.isAuthenticated() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.email.trim()))
      errors.email = 'Enter a valid email.';
    if (!this.auth.isAuthenticated() && this.password.length < 8)
      errors.password = 'Use at least 8 characters.';
    this.errors.set(errors);
    if (errors.email || errors.password) {
      (errors.email ? this.emailField : this.passwordField)?.nativeElement.focus();
      return;
    }
    this.pending.set(true);
    try {
      if (!this.auth.isAuthenticated()) await this.auth.login(this.email.trim(), this.password);
      const opened = await this.router.navigateByUrl('/network');
      if (!opened) this.errors.set({ form: 'Could not open the workspace. Try again.' });
    } catch {
      this.errors.set({
        form: this.auth.isAuthenticated()
          ? 'Could not open the workspace. Try again.'
          : 'Sign-in failed. Try again.',
      });
    } finally {
      this.pending.set(false);
    }
  }
}
