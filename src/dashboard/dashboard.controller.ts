import { Body, Controller, Get, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { DbRetryInterceptor } from '../common/db-retry.interceptor';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { DASHBOARD_ROLES, dashboardFor } from '../common/roles';
import { AdminService } from '../admin/admin.service';
import { SupportService } from '../support/support.service';
import { TokensService } from '../tokens/tokens.service';
import { FREE_SIGNUP_TOKENS } from '../tokens/token-pricing.config';
import { CreateBugReportDto } from './dashboard.dto';

type Me = { id: string; email: string; firstName?: string; lastName?: string; role: string; tokens: number; lastLoginAt?: Date | null; createdAt?: Date };

const profile = (u: Me) => ({
  id: u.id,
  email: u.email,
  firstName: u.firstName ?? null,
  lastName: u.lastName ?? null,
  role: u.role,
  tokens: u.tokens,
  lastLoginAt: u.lastLoginAt ?? null,
  createdAt: u.createdAt ?? null,
});

/**
 * Entry point for every dashboard account. After POST /auth/admin-login the frontend calls GET /dashboard/me
 * (e.g. on a page refresh) to learn who is signed in and which dashboard to show.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...DASHBOARD_ROLES)
@Controller('dashboard')
export class DashboardController {
  @Get('me')
  me(@CurrentUser() user: Me) {
    return { user: profile(user), dashboard: dashboardFor(user.role) };
  }
}

/**
 * TESTER dashboard. A tester sees only their own account - nothing about other users, payments or the
 * helpdesk. SUPER_ADMIN may open it too, to preview what testers see.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(DbRetryInterceptor)
@Roles('TESTER', 'SUPER_ADMIN')
@Controller('dashboard/tester')
export class TesterDashboardController {
  constructor(
    private tokens: TokensService,
    private support: SupportService,
  ) {}

  /** Everything the tester home screen shows. */
  @Get('overview')
  async overview(@CurrentUser() user: Me) {
    const [usage, recentActivity, tickets] = await Promise.all([
      this.tokens.getUsageSummary(user.id),
      this.tokens.getLedger(user.id, 10),
      this.support.listMine(user.id),
    ]);
    return {
      user: profile(user),
      environment: {
        name: process.env.NODE_ENV ?? 'development',
        apiVersion: 'v1',
        freeSignupTokens: FREE_SIGNUP_TOKENS,
        pricing: this.tokens.pricing(),
      },
      usage,
      recentActivity,
      bugReports: {
        total: tickets.length,
        open: tickets.filter((t) => t.status !== 'CLOSED').length,
      },
    };
  }

  /** The tester's own bug reports (support tickets they opened), newest first. */
  @Get('bug-reports')
  bugReports(@CurrentUser('id') userId: string) {
    return this.support.listMine(userId);
  }

  /** Report a bug. Creates a helpdesk ticket under the tester's account, flagged "[Bug]" so admins can spot it. */
  @Post('bug-reports')
  createBugReport(@CurrentUser() user: Me, @Body() dto: CreateBugReportDto) {
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;
    return this.support.createTicket({
      userId: user.id,
      name,
      email: user.email,
      subject: `[Bug] ${dto.title.trim()}`,
      message: dto.details,
      source: 'HELPDESK',
    });
  }
}

/**
 * STAFF dashboard: the countdown (total user count) and nothing else. The live SSE feed is
 * GET /admin/countdown/stream (see CountdownController).
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(DbRetryInterceptor)
@Roles('STAFF', 'SUPER_ADMIN')
@Controller('dashboard/staff')
export class StaffDashboardController {
  constructor(private admin: AdminService) {}

  @Get('overview')
  async overview(@CurrentUser() user: Me) {
    return { user: profile(user), countdown: await this.admin.totalUsers() };
  }
}

/**
 * MANAGEMENT dashboard home: sign-up numbers and revenue. Users and payments live under /admin/users and
 * /admin/payments (already open to MANAGEMENT); the live feed is GET /admin/stream.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(DbRetryInterceptor)
@Roles('MANAGEMENT', 'SUPER_ADMIN')
@Controller('dashboard/management')
export class ManagementDashboardController {
  constructor(private admin: AdminService) {}

  @Get('overview')
  async overview(@CurrentUser() user: Me) {
    const [counts, payments] = await Promise.all([this.admin.userCounts(), this.admin.paymentSummary()]);
    return { user: profile(user), counts, payments };
  }
}
