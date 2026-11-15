import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { DbRetryInterceptor } from '../common/db-retry.interceptor';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { LocalJobBoardsService } from './local-job-boards.service';
import { CreateLocalJobBoardDto, ListLocalJobBoardsQueryDto, UpdateLocalJobBoardDto } from './local-job-boards.dto';

/**
 * Local job boards (the job links kept per country), managed from the dashboard.
 * Full create / read / update / delete for ADMIN and SUPER_ADMIN. Everyone else is refused by RolesGuard.
 *
 *   GET    /admin/local-job-boards          list (no links), ?search= &page= &limit=
 *   GET    /admin/local-job-boards/:id      one board with all its links
 *   POST   /admin/local-job-boards          { country, links }   links = pasted text or an array
 *   PATCH  /admin/local-job-boards/:id      { country?, links?, mode?: replace | append | remove }
 *   DELETE /admin/local-job-boards/:id
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(DbRetryInterceptor)
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/local-job-boards')
export class LocalJobBoardsController {
  constructor(private boards: LocalJobBoardsService) {}

  @Get()
  list(@Query() query: ListLocalJobBoardsQueryDto) {
    return this.boards.list(query);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.boards.get(id);
  }

  @Post()
  create(@CurrentUser() actor: { id: string; role: string }, @Body() dto: CreateLocalJobBoardDto) {
    return this.boards.create({ id: actor.id, role: actor.role }, dto);
  }

  @Patch(':id')
  update(@CurrentUser() actor: { id: string; role: string }, @Param('id') id: string, @Body() dto: UpdateLocalJobBoardDto) {
    return this.boards.update({ id: actor.id, role: actor.role }, id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.boards.remove(id);
  }
}
