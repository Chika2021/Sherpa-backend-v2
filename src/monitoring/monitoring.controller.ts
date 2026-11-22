import { Body, Controller, Get, Param, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { DbRetryInterceptor } from '../common/db-retry.interceptor';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { MonitoringService, ReviewActor } from './monitoring.service';
import { ListFlagsQueryDto, ReviewNoteDto, SuspendUserDto, WarnUserDto } from './monitoring.dto';

const actorOf = (u: any): ReviewActor => ({
  id: u.id,
  role: u.role,
  name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || 'Admin',
});

/**
 * Review queue for flagged accounts. ADMIN and SUPER_ADMIN can read it and warn, suspend, dismiss or reinstate.
 * (ADMIN can act on normal user accounts; SUPER_ADMIN also on tester/staff/admin/management accounts.)
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(DbRetryInterceptor)
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/flags')
export class MonitoringController {
  constructor(private monitoring: MonitoringService) {}

  @Get('summary')
  summary() {
    return this.monitoring.summary();
  }

  /** ?status=OPEN|WARNED|SUSPENDED|DISMISSED|RESOLVED|ALL (default OPEN) &severity= &search= &page= &limit= */
  @Get()
  list(@Query() q: ListFlagsQueryDto) {
    return this.monitoring.list(q);
  }

  /** The flag with the reason, the activity, the user, their warnings, other flags, referral links and recent token activity. */
  @Get(':id')
  one(@Param('id') id: string) {
    return this.monitoring.get(id);
  }

  /** Body: { message } - sent to the user as a notification and an email. */
  @Post(':id/warn')
  warn(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: WarnUserDto) {
    return this.monitoring.warn(actorOf(user), id, dto.message);
  }

  /** Body: { reason } - the account cannot sign in or call the API; the reason is shown to the user. */
  @Post(':id/suspend')
  suspend(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: SuspendUserDto) {
    return this.monitoring.suspend(actorOf(user), id, dto.reason);
  }

  /** Body: { note? } - reviewed, nothing wrong. */
  @Post(':id/dismiss')
  dismiss(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: ReviewNoteDto) {
    return this.monitoring.dismiss(actorOf(user), id, dto.note);
  }

  /** Body: { note? } - lifts a suspension that came from this flag. */
  @Post(':id/reinstate')
  reinstate(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: ReviewNoteDto) {
    return this.monitoring.reinstate(actorOf(user), id, dto.note);
  }
}
