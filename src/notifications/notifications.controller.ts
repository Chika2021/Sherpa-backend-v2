import { Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { NotificationsService } from './notifications.service';

/** The signed-in user's own notifications. Admin alerts use the same endpoints - they are just notifications of type FLAG. */
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private notifications: NotificationsService) {}

  /** ?limit=1-100 (default 30) &unread=true &before=<ISO date> (for "load older"). Also returns the unread count. */
  @Get()
  list(
    @CurrentUser('id') userId: string,
    @Query('limit') limit?: string,
    @Query('unread') unread?: string,
    @Query('before') before?: string,
  ) {
    return this.notifications.list(userId, { limit: limit ? Number(limit) : undefined, unreadOnly: unread === 'true', before });
  }

  @Get('unread-count')
  unreadCount(@CurrentUser('id') userId: string) {
    return this.notifications.unreadCount(userId);
  }

  @Post('read-all')
  readAll(@CurrentUser('id') userId: string) {
    return this.notifications.markAllRead(userId);
  }

  @Delete('read')
  clearRead(@CurrentUser('id') userId: string) {
    return this.notifications.clearRead(userId);
  }

  @Post(':id/read')
  read(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.notifications.markRead(userId, id);
  }

  @Delete(':id')
  remove(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.notifications.remove(userId, id);
  }
}
