import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, QueryFailedError, Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { User, normalizeEmail } from '../entities/user.entity';
import { dashboardFor, isDashboardRole } from '../common/roles';
import { isUuid } from '../database/db-utils';
import { SUPER_ADMIN_BACKEND_ONLY_MESSAGE, isBackendRequest } from '../common/super-admin-access';
import { MailService } from '../mail/mail.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TokensService } from '../tokens/tokens.service';
import { SessionTrackerService } from './session-tracker.service';
import { FREE_SIGNUP_TOKENS } from '../tokens/token-pricing.config';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User) private users: Repository<User>,
    private jwt: JwtService,
    private config: ConfigService,
    private mail: MailService,
    private tokens: TokensService,
    private realtime: RealtimeService,
    private tracker: SessionTrackerService,
  ) {}

  async register(dto: RegisterDto) {
    const email = normalizeEmail(dto.email);
    const existing = await this.users.findOneBy({ email });
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    let user: User;
    try {
      user = await this.users.save(
        this.users.create({
          email,
          passwordHash,
          firstName: dto.firstName,
          lastName: dto.lastName,
          tokens: 0,
        }),
      );
    } catch (err) {
      // Two simultaneous sign-ups with the same email: the unique index catches the loser.
      if (err instanceof QueryFailedError && (err as any).driverError?.code === '23505') {
        throw new ConflictException('An account with this email already exists');
      }
      throw err;
    }

    // Free tokens to try the app with. Granted through TokensService (rather
    // than a schema default) so the signup bonus lands in the token ledger
    // like every other balance change and the ledger always reconciles
    // against the balance. A failure here must not fail the registration -
    // the account is already created, so log it and let support top them up.
    let tokens = user.tokens;
    if (FREE_SIGNUP_TOKENS > 0) {
      try {
        const { balanceAfter } = await this.tokens.credit(user.id, FREE_SIGNUP_TOKENS, {
          entryType: 'BONUS',
          label: 'signup-bonus',
        });
        tokens = balanceAfter;
      } catch (err) {
        this.logger.error(`Signup bonus failed for ${user.id}: ${(err as Error).message}`);
      }
    }

    // Tell the admin dashboard's live counter a new user just joined.
    this.realtime.publish({
      type: 'user.registered',
      user: {
        id: user.id,
        email: user.email,
        name: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email,
        createdAt: user.createdAt,
      },
    });

    void this.tracker.startLogin({ id: user.id, role: user.role ?? 'USER' });

    return this.buildAuthResponse(user.id, user.email, {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      tokens,
      role: user.role ?? 'USER',
    });
  }

  /** Checks the email + password and the suspended flag. Shared by the normal and the dashboard login. */
  private async authenticate(dto: LoginDto): Promise<User> {
    const user = await this.users.findOneBy({ email: normalizeEmail(dto.email) });
    if (!user) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Invalid credentials');
    if (user.suspended) {
      throw new ForbiddenException('This account has been suspended. Please contact support.');
    }
    return user;
  }

  /** The super admin may only sign in from the backend (see common/super-admin-access.ts). Runs after the password check. */
  private assertSuperAdminFromBackend(user: User, req?: { headers: Record<string, string | string[] | undefined> }) {
    if (user.role === 'SUPER_ADMIN' && !isBackendRequest(req, this.config.get<string>('SUPER_ADMIN_ALLOWED_ORIGINS'))) {
      throw new ForbiddenException(SUPER_ADMIN_BACKEND_ONLY_MESSAGE);
    }
  }

  private signIn(user: User) {
    // Best-effort: never fail a login because the timestamp write failed.
    this.users.update({ id: user.id }, { lastLoginAt: new Date() }).catch(() => undefined);
    // Start a visit in the activity log (also best-effort).
    void this.tracker.startLogin({ id: user.id, role: user.role });

    return this.buildAuthResponse(user.id, user.email, {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      tokens: user.tokens,
      role: user.role ?? 'USER',
    });
  }

  /** Normal app login. Dashboard accounts get `dashboard` in the response too, so any login screen can redirect them. */
  async login(dto: LoginDto, req?: { headers: Record<string, string | string[] | undefined> }) {
    const user = await this.authenticate(dto);
    this.assertSuperAdminFromBackend(user, req);
    return this.signIn(user);
  }

  /**
   * Dashboard login. Same credentials check as `login`, but only TESTER, STAFF, ADMIN, MANAGEMENT and
   * SUPER_ADMIN accounts get in. The response carries `dashboard` ({ key, path, label, permissions }) -
   * the frontend redirects to `dashboard.path`, so a tester lands on the tester dashboard, staff on the
   * staff dashboard, and so on. The role check runs AFTER the password check so this endpoint can't be
   * used to find out which emails belong to dashboard accounts.
   */
  async adminLogin(dto: LoginDto, req?: { headers: Record<string, string | string[] | undefined> }) {
    const user = await this.authenticate(dto);
    this.assertSuperAdminFromBackend(user, req);
    if (!isDashboardRole(user.role)) {
      throw new ForbiddenException('This account does not have dashboard access.');
    }
    return this.signIn(user);
  }

  /** The app signed out: stamps the end of the current visit so the time spent in the app is exact. */
  async logout(userId: string) {
    await this.tracker.end(userId);
    return { message: 'Signed out.' };
  }

  /** Updates the password for an already-authenticated user. */
  async changePassword(userId: string, dto: ChangePasswordDto) {
    if (!isUuid(userId)) throw new UnauthorizedException('Invalid credentials');
    const user = await this.users.findOneBy({ id: userId });
    if (!user) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Current password is incorrect');

    user.passwordHash = await bcrypt.hash(dto.newPassword, 10);
    await this.users.save(user);

    return { message: 'Password updated successfully.' };
  }

  /**
   * Starts password recovery: if the email matches an account, emails a
   * one-time reset link. Always returns the same generic response either
   * way, so this endpoint can't be used to enumerate registered emails.
   */
  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.users.findOneBy({ email: normalizeEmail(dto.email) });

    if (user) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      user.passwordResetTokenHash = this.hashToken(rawToken);
      user.passwordResetExpiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
      await this.users.save(user);

      const baseUrl =
        this.config.get<string>('FRONTEND_URL') || this.config.get<string>('APP_URL') || 'http://localhost:3000';
      const resetUrl = `${baseUrl.replace(/\/$/, '')}/reset-password?token=${rawToken}`;
      // Don't await: a slow/failing mail provider must not hang or 500 the
      // request (and a failure must not reveal whether the email exists).
      this.mail.sendPasswordResetEmail(user.email, resetUrl).catch((err) => {
        this.logger.error(`Password reset email to ${user.email} failed: ${(err as Error).message}`);
      });
    }

    return { message: 'If that email is registered, a password reset link has been sent.' };
  }

  /** Completes password recovery given the raw token that was emailed to the user. */
  async resetPassword(dto: ResetPasswordDto) {
    const user = await this.users.findOne({
      where: {
        passwordResetTokenHash: this.hashToken(dto.token),
        passwordResetExpiresAt: MoreThan(new Date()),
      },
    });
    if (!user) throw new BadRequestException('Invalid or expired reset token');

    user.passwordHash = await bcrypt.hash(dto.newPassword, 10);
    // null, not undefined: TypeORM ignores undefined, so this is what really clears the columns.
    user.passwordResetTokenHash = null;
    user.passwordResetExpiresAt = null;
    await this.users.save(user);

    return { message: 'Password has been reset. You can now log in.' };
  }

  private hashToken(token: string) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private buildAuthResponse(userId: string, email: string, user: any) {
    const accessToken = this.jwt.sign({ sub: userId, email });
    // `dashboard` is null for a normal USER account.
    return { accessToken, user, dashboard: dashboardFor(user?.role) };
  }
}