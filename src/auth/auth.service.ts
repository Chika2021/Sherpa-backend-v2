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
import { ReferralsService } from '../referrals/referrals.service';
import { MonitoringService } from '../monitoring/monitoring.service';
import { NotificationsService } from '../notifications/notifications.service';
import { canonicalEmail, RequestFingerprint } from '../common/identity.util';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const VERIFY_RESEND_COOLDOWN_MS = 60 * 1000;

type Req = { headers: Record<string, string | string[] | undefined>; ip?: string; socket?: { remoteAddress?: string } };

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
    private referrals: ReferralsService,
    private monitoring: MonitoringService,
    private notifications: NotificationsService,
  ) {}

  async register(dto: RegisterDto, req?: Req) {
    const email = normalizeEmail(dto.email);
    const existing = await this.users.findOneBy({ email });
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }

    const fp = this.monitoring.fingerprint(req);
    const canonical = canonicalEmail(email);
    const passwordHash = await bcrypt.hash(dto.password, 10);

    // Email verification token: only its hash is stored, the raw value goes in the email.
    const verifyToken = crypto.randomBytes(32).toString('hex');

    let user: User | undefined;
    for (let attempt = 1; attempt <= 3 && !user; attempt++) {
      try {
        user = await this.users.save(
          this.users.create({
            email,
            passwordHash,
            firstName: dto.firstName,
            lastName: dto.lastName,
            tokens: 0,
            referralCode: await this.referrals.uniqueCode(),
            emailCanonical: canonical,
            signupIpHash: fp.ipHash,
            signupDeviceHash: fp.deviceHash,
            lastIpHash: fp.ipHash,
            lastDeviceHash: fp.deviceHash,
            emailVerificationTokenHash: this.hashToken(verifyToken),
            emailVerificationExpiresAt: new Date(Date.now() + VERIFY_TOKEN_TTL_MS),
            emailVerificationSentAt: new Date(),
          }),
        );
      } catch (err) {
        if (err instanceof QueryFailedError && (err as any).driverError?.code === '23505') {
          // Two simultaneous sign-ups with the same email: the unique index catches the loser.
          // (A clash on the referral code instead is astronomically unlikely - just try again with a new one.)
          if (String((err as any).driverError?.detail ?? '').includes('(email)')) {
            throw new ConflictException('An account with this email already exists');
          }
          if (attempt < 3) continue;
        }
        throw err;
      }
    }
    if (!user) throw new ConflictException('Could not create the account. Please try again.');

    // Free tokens to try the app with. Granted through TokensService (rather
    // than a schema default) so the signup bonus lands in the token ledger
    // like every other balance change and the ledger always reconciles
    // against the balance. A failure here must not fail the registration -
    // the account is already created, so log it and let support top them up.
    let signupTokens = 0;
    if (FREE_SIGNUP_TOKENS > 0) {
      try {
        await this.tokens.credit(user.id, FREE_SIGNUP_TOKENS, {
          entryType: 'BONUS',
          label: 'signup-bonus',
        });
        signupTokens = FREE_SIGNUP_TOKENS;
      } catch (err) {
        this.logger.error(`Signup bonus failed for ${user.id}: ${(err as Error).message}`);
      }
    }

    // Signed up through a friend's link? Adds the friend bonus (and never throws).
    const referral = await this.referrals.applyAtSignup(user, dto.referralCode, { fp, canonical });

    let tokens = signupTokens + referral.bonusTokens;
    try {
      tokens = await this.tokens.getBalance(user.id);
    } catch {
      // fall back to the sum above
    }

    // The email that makes the referrer's reward possible: they only earn once this link is clicked.
    this.sendVerificationEmail(user, verifyToken);

    void this.notifications.notify(user.id, {
      type: 'ACCOUNT',
      title: 'Welcome to Sherpar',
      body:
        `You have ${tokens} free token${tokens === 1 ? '' : 's'} to try the AI tools` +
        (referral.applied && referral.bonusTokens ? `, including ${referral.bonusTokens} bonus tokens from your friend's invite` : '') +
        '. Please confirm your email address so we can keep your account safe.',
      link: '/billing',
    });

    // Sign-up rules: same network / device / mailbox, throwaway domains.
    void this.monitoring.onRegistration(user, fp, canonical);

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

    return {
      ...this.buildAuthResponse(user.id, user.email, {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        tokens,
        role: user.role ?? 'USER',
        emailVerified: false,
        referralCode: user.referralCode,
      }),
      referral,
    };
  }

  // ---------------------------------------------------------------- email verification

  private sendVerificationEmail(user: Pick<User, 'email' | 'firstName'>, rawToken: string) {
    const baseUrl = this.config.get<string>('FRONTEND_URL') || this.config.get<string>('APP_URL') || 'http://localhost:3000';
    const url = `${baseUrl.replace(/\/$/, '')}/verify-email?token=${rawToken}`;
    // Not awaited: a slow mail provider must not slow or fail the sign-up.
    this.mail.sendVerificationEmail(user.email, url, user.firstName).catch((err) => {
      this.logger.error(`Verification email to ${user.email} failed: ${(err as Error).message}`);
    });
  }

  /** Completes email verification from the emailed link. Pays the referrer (if any) after the address is confirmed. */
  async verifyEmail(dto: VerifyEmailDto) {
    const user = await this.users.findOne({
      where: {
        emailVerificationTokenHash: this.hashToken(dto.token),
        emailVerificationExpiresAt: MoreThan(new Date()),
      },
    });
    if (!user) throw new BadRequestException('This verification link is invalid or has expired. Request a new one from your account.');

    await this.users.update(
      { id: user.id },
      { emailVerifiedAt: user.emailVerifiedAt ?? new Date(), emailVerificationTokenHash: null, emailVerificationExpiresAt: null },
    );

    void this.notifications.notify(user.id, {
      type: 'ACCOUNT',
      title: 'Email confirmed',
      body: 'Thanks, your email address is confirmed.',
    });
    // Only now does a referrer earn anything for this friend.
    await this.referrals.onEmailVerified(user.id);

    return { verified: true, email: user.email, message: 'Your email is confirmed.' };
  }

  /** Sends a new verification link to a signed-in, not-yet-verified user. */
  async resendVerification(userId: string) {
    if (!isUuid(userId)) throw new UnauthorizedException('Invalid credentials');
    const user = await this.users
      .createQueryBuilder('u')
      .addSelect('u.emailVerificationSentAt')
      .where('u.id = :id', { id: userId })
      .getOne();
    if (!user) throw new UnauthorizedException('Invalid credentials');
    if (user.emailVerifiedAt) return { sent: false, message: 'Your email is already confirmed.' };

    const last = user.emailVerificationSentAt?.getTime() ?? 0;
    const wait = VERIFY_RESEND_COOLDOWN_MS - (Date.now() - last);
    if (wait > 0) {
      throw new BadRequestException(`Please wait ${Math.ceil(wait / 1000)} seconds before asking for another email.`);
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    await this.users.update(
      { id: user.id },
      {
        emailVerificationTokenHash: this.hashToken(rawToken),
        emailVerificationExpiresAt: new Date(Date.now() + VERIFY_TOKEN_TTL_MS),
        emailVerificationSentAt: new Date(),
      },
    );
    this.sendVerificationEmail(user, rawToken);
    return { sent: true, message: `We sent a confirmation link to ${user.email}.` };
  }

  /** Checks the email + password and the suspended flag. Shared by the normal and the dashboard login. */
  private async authenticate(dto: LoginDto, req?: Req): Promise<User> {
    const user = await this.users.findOneBy({ email: normalizeEmail(dto.email) });
    if (!user) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) {
      // A burst of wrong passwords against one account is reported to the admins (monitoring never blocks the login flow).
      this.monitoring.noteFailedLogin(user, this.monitoring.fingerprint(req).maskedIp);
      throw new UnauthorizedException('Invalid credentials');
    }
    if (user.suspended) {
      throw new ForbiddenException(
        user.suspendedReason
          ? `This account has been suspended. Reason: ${user.suspendedReason}. Please contact support if you think this is a mistake.`
          : 'This account has been suspended. Please contact support.',
      );
    }
    return user;
  }

  /** The super admin may only sign in from the backend (see common/super-admin-access.ts). Runs after the password check. */
  private assertSuperAdminFromBackend(user: User, req?: { headers: Record<string, string | string[] | undefined> }) {
    if (user.role === 'SUPER_ADMIN' && !isBackendRequest(req, this.config.get<string>('SUPER_ADMIN_ALLOWED_ORIGINS'))) {
      throw new ForbiddenException(SUPER_ADMIN_BACKEND_ONLY_MESSAGE);
    }
  }

  private signIn(user: User, req?: Req) {
    // Best-effort: never fail a login because the timestamp write failed. Also remembers the latest network/device,
    // which is what the referral self-check and the multi-account rules compare against.
    const fp: RequestFingerprint = this.monitoring.fingerprint(req);
    this.monitoring.noteLoginSuccess(user.id);
    this.users
      .update(
        { id: user.id },
        { lastLoginAt: new Date(), ...(fp.ipHash ? { lastIpHash: fp.ipHash } : {}), ...(fp.deviceHash ? { lastDeviceHash: fp.deviceHash } : {}) },
      )
      .catch(() => undefined);
    // Start a visit in the activity log (also best-effort).
    void this.tracker.startLogin({ id: user.id, role: user.role });

    return this.buildAuthResponse(user.id, user.email, {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      tokens: user.tokens,
      role: user.role ?? 'USER',
      emailVerified: !!user.emailVerifiedAt,
      referralCode: user.referralCode ?? undefined,
    });
  }

  /** Normal app login. Dashboard accounts get `dashboard` in the response too, so any login screen can redirect them. */
  async login(dto: LoginDto, req?: { headers: Record<string, string | string[] | undefined> }) {
    const user = await this.authenticate(dto, req);
    this.assertSuperAdminFromBackend(user, req);
    return this.signIn(user, req);
  }

  /**
   * Dashboard login. Same credentials check as `login`, but only TESTER, STAFF, ADMIN, MANAGEMENT and
   * SUPER_ADMIN accounts get in. The response carries `dashboard` ({ key, path, label, permissions }) -
   * the frontend redirects to `dashboard.path`, so a tester lands on the tester dashboard, staff on the
   * staff dashboard, and so on. The role check runs AFTER the password check so this endpoint can't be
   * used to find out which emails belong to dashboard accounts.
   */
  async adminLogin(dto: LoginDto, req?: { headers: Record<string, string | string[] | undefined> }) {
    const user = await this.authenticate(dto, req);
    this.assertSuperAdminFromBackend(user, req);
    if (!isDashboardRole(user.role)) {
      throw new ForbiddenException('This account does not have dashboard access.');
    }
    return this.signIn(user, req);
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