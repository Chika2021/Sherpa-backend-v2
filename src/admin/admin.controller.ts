import { Body, Controller, Delete, Get, MessageEvent, Param, Patch, Post, Query, Sse, UseGuards, UseInterceptors } from '@nestjs/common';
import { EMPTY, Observable, concat, defer, from, interval, map, merge, mergeMap, of } from 'rxjs';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { DbRetryInterceptor } from '../common/db-retry.interceptor';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RealtimeService } from '../realtime/realtime.service';
import { AdminService } from './admin.service';
import { AppInfoService } from './app-info.service';
import { CreateUserDto, GrantTokensDto, ListPaymentsQueryDto, ListUsersQueryDto, UpdateUserDto } from './admin.dto';

/**
 * Dashboard API. Who can do what:
 *   read overview / signups / live stream / users   ADMIN, MANAGEMENT, SUPER_ADMIN
 *   create, update, delete users                    MANAGEMENT (user/tester/staff only), SUPER_ADMIN
 *   payments (how much was paid, and by whom)       MANAGEMENT, SUPER_ADMIN
 *   grant tokens, App info (/system)                SUPER_ADMIN only
 * STAFF has its own countdown-only endpoints (CountdownController); the helpdesk is in SupportAdminController.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(DbRetryInterceptor)
@Roles('ADMIN', 'MANAGEMENT', 'SUPER_ADMIN')
@Controller('admin')
export class AdminController {
  constructor(
    private admin: AdminService,
    private appInfo: AppInfoService,
    private realtime: RealtimeService,
  ) {}

  @Get('overview')
  async overview(@CurrentUser('role') role: string) {
    const o = await this.admin.overview();
    // Revenue is for management and the super admin; the helpdesk numbers are not for management.
    if (role === 'ADMIN') return { ...o, billing: { tokensInCirculation: o.billing.tokensInCirculation, tokensSpentAllTime: o.billing.tokensSpentAllTime } };
    if (role === 'MANAGEMENT') {
      const { support, ...rest } = o;
      return rest;
    }
    return o;
  }

  @Get('signups')
  signups(@Query('days') days?: string) {
    return this.admin.signups(days ? Number(days) : 30);
  }

  /** Everything about the app itself: stack, complexity, architecture, database, integrations. Super admin only. */
  @Roles('SUPER_ADMIN')
  @Get('system')
  system() {
    return this.appInfo.collect();
  }

  /**
   * Live feed (Server-Sent Events). Sends the current user counts immediately, then a fresh count the
   * moment someone registers or an account is deleted, and re-checks the database every 10s as a safety net.
   * Helpdesk events are left out for MANAGEMENT.
   * The dashboard reads it with fetch() so the JWT stays in the Authorization header, not the URL.
   */
  @Sse('stream')
  stream(@CurrentUser('role') role: string): Observable<MessageEvent> {
    const counts = () => defer(() => from(this.admin.userCounts())).pipe(map((data) => ({ type: 'counts', data }) as MessageEvent));

    const onEvent$ = this.realtime.events$.pipe(
      mergeMap((event) => {
        if (event.type === 'user.registered') return concat(of({ type: 'registered', data: event.user } as MessageEvent), counts());
        if (event.type === 'user.deleted') return counts();
        return role === 'MANAGEMENT' ? EMPTY : of({ type: event.type, data: event } as MessageEvent);
      }),
    );

    const poll$ = interval(10_000).pipe(mergeMap(() => counts()));
    return merge(counts(), onEvent$, poll$);
  }

  @Get('users')
  users(@Query() query: ListUsersQueryDto) {
    return this.admin.listUsers(query);
  }

  @Get('users/:id')
  user(@Param('id') id: string) {
    return this.admin.getUser(id);
  }

  // ---- user management: SUPER_ADMIN and MANAGEMENT (what MANAGEMENT may touch is enforced in AdminService) ----

  @Roles('SUPER_ADMIN', 'MANAGEMENT')
  @Post('users')
  createUser(@CurrentUser() actor: { id: string; role: string }, @Body() dto: CreateUserDto) {
    return this.admin.createUser({ id: actor.id, role: actor.role }, dto);
  }

  @Roles('SUPER_ADMIN', 'MANAGEMENT')
  @Patch('users/:id')
  updateUser(@CurrentUser() actor: { id: string; role: string }, @Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.admin.updateUser({ id: actor.id, role: actor.role }, id, dto);
  }

  @Roles('SUPER_ADMIN', 'MANAGEMENT')
  @Delete('users/:id')
  deleteUser(@CurrentUser() actor: { id: string; role: string }, @Param('id') id: string) {
    return this.admin.deleteUser({ id: actor.id, role: actor.role }, id);
  }

  @Roles('SUPER_ADMIN')
  @Post('users/:id/tokens')
  grantTokens(@CurrentUser() actor: { id: string; role: string }, @Param('id') id: string, @Body() dto: GrantTokensDto) {
    return this.admin.grantTokens({ id: actor.id, role: actor.role }, id, dto.amount, dto.note);
  }

  // ---- payments: SUPER_ADMIN and MANAGEMENT ----

  @Roles('SUPER_ADMIN', 'MANAGEMENT')
  @Get('payments/summary')
  paymentSummary() {
    return this.admin.paymentSummary();
  }

  @Roles('SUPER_ADMIN', 'MANAGEMENT')
  @Get('payments')
  payments(@Query() query: ListPaymentsQueryDto) {
    return this.admin.listPayments(query);
  }
}
