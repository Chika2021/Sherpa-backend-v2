import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RateLimiter, clientIp } from '../common/rate-limiter';
import { SupportService } from './support.service';
import { ContactDto, CreateTicketDto, ListTicketsQueryDto, ReplyDto, SetStatusDto } from './support.dto';

const contactLimiter = new RateLimiter(5, 10 * 60 * 1000); // 5 messages / 10 min / IP

/** Public contact form (homepage) - no login needed. */
@Controller('support')
export class SupportPublicController {
  constructor(private support: SupportService) {}

  @Post('contact')
  async contact(@Body() dto: ContactDto, @Req() req: Request) {
    // Bots fill the hidden field: pretend it worked, store nothing.
    if (dto.website) return { ok: true, message: "Thanks - we've received your message." };
    contactLimiter.check(clientIp(req));

    await this.support.createTicket({
      name: dto.name,
      email: dto.email,
      subject: dto.subject?.trim() || 'Contact form message',
      message: dto.message,
      source: 'CONTACT_FORM',
    });
    return { ok: true, message: "Thanks - we've received your message and will reply by email." };
  }
}

/** Helpdesk for signed-in users: open a ticket, follow replies. */
@UseGuards(JwtAuthGuard)
@Controller('support/tickets')
export class SupportUserController {
  constructor(private support: SupportService) {}

  @Post()
  create(@CurrentUser() user: any, @Body() dto: CreateTicketDto) {
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;
    return this.support.createTicket({
      userId: user.id,
      name,
      email: user.email,
      subject: dto.subject,
      message: dto.message,
      source: dto.source ?? 'HELPDESK',
    });
  }

  @Get()
  mine(@CurrentUser('id') userId: string) {
    return this.support.listMine(userId);
  }

  @Get('unread-count')
  unread(@CurrentUser('id') userId: string) {
    return this.support.unreadCount(userId);
  }

  @Get(':id')
  one(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.support.getMine(id, userId);
  }

  @Post(':id/reply')
  reply(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: ReplyDto) {
    return this.support.customerReply(id, userId, dto.body);
  }
}

/** Admin side of the helpdesk. ADMIN can read tickets; only SUPER_ADMIN can reply or change a status. */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/support')
export class SupportAdminController {
  constructor(private support: SupportService) {}

  @Get('summary')
  summary() {
    return this.support.adminSummary();
  }

  @Get('tickets')
  list(@Query() q: ListTicketsQueryDto) {
    return this.support.adminList(q);
  }

  @Get('tickets/:id')
  one(@Param('id') id: string) {
    return this.support.adminGet(id);
  }

  @Roles('SUPER_ADMIN')
  @Post('tickets/:id/reply')
  reply(@CurrentUser() admin: any, @Param('id') id: string, @Body() dto: ReplyDto) {
    const name = [admin.firstName, admin.lastName].filter(Boolean).join(' ') || 'Support';
    return this.support.adminReply(id, { id: admin.id, name }, dto.body);
  }

  @Roles('SUPER_ADMIN')
  @Patch('tickets/:id/status')
  status(@Param('id') id: string, @Body() dto: SetStatusDto) {
    return this.support.adminSetStatus(id, dto.status);
  }
}
