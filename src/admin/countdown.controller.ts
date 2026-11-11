import { Controller, Get, MessageEvent, Sse, UseGuards } from '@nestjs/common';
import { Observable, defer, filter, from, interval, map, merge, mergeMap } from 'rxjs';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RealtimeService } from '../realtime/realtime.service';
import { AdminService } from './admin.service';

/**
 * The only thing STAFF can read: the total number of users. Nothing about who they are, no tickets,
 * no revenue. ADMIN, MANAGEMENT and SUPER_ADMIN may use it too (the dashboard's Countdown screen).
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('STAFF', 'ADMIN', 'MANAGEMENT', 'SUPER_ADMIN')
@Controller('admin/countdown')
export class CountdownController {
  constructor(
    private admin: AdminService,
    private realtime: RealtimeService,
  ) {}

  @Get()
  total() {
    return this.admin.totalUsers();
  }

  /** SSE: `counts` events carrying only { totalUsers, at } - now, on every sign-up, and every 10s. */
  @Sse('stream')
  stream(): Observable<MessageEvent> {
    const toEvent = () => from(this.admin.totalUsers()).pipe(map((data) => ({ type: 'counts', data }) as MessageEvent));
    return merge(
      defer(toEvent),
      this.realtime.events$.pipe(
        filter((e) => e.type === 'user.registered' || e.type === 'user.deleted'),
        mergeMap(toEvent),
      ),
      interval(10_000).pipe(mergeMap(toEvent)),
    );
  }
}
