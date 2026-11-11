import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ApplicationsService } from '../applications.service';
import { GuidedApplyService } from './guided-apply.service';
import { GuidedAnswersDto } from './dto/guided-answers.dto';
import { MarkAppliedDto } from './dto/mark-applied.dto';
import { StartGuidedDto, UpdateGuidedDetailsDto } from './dto/start-guided.dto';

/**
 * Guided "copy & paste" application:
 *
 *   1. POST   /applications/guided                    job details (all optional) [+ applyUrl | jobId]  -> application
 *   2. POST   /applications/guided/:id/prepare        { formText | applyUrl }  -> tailored resume + cover letter + an answer per question
 *        (or separately: POST :id/answers  and  POST :id/documents)
 *      PATCH  /applications/guided/:id                edit the job details
 *      GET    /applications/guided/:id                application + documents + saved answers
 *   3. POST   /applications/guided/:id/applied        the user pressed "Applied" -> registered as applied
 *      DELETE /applications/guided/:id/applied        undo that
 *
 * Nothing here ever submits anything to the employer's site.
 */
@UseGuards(JwtAuthGuard)
@Controller('applications/guided')
export class GuidedApplyController {
  constructor(
    private guided: GuidedApplyService,
    private applications: ApplicationsService,
  ) {}

  @Post()
  start(@CurrentUser('id') userId: string, @Body() dto: StartGuidedDto) {
    return this.guided.start(userId, dto);
  }

  @Get(':id')
  getOne(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.applications.getOwnedForResponse(userId, id);
  }

  @Patch(':id')
  update(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: UpdateGuidedDetailsDto) {
    return this.guided.updateDetails(userId, id, dto);
  }

  @Post(':id/prepare')
  prepare(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: GuidedAnswersDto) {
    return this.guided.prepare(userId, id, dto);
  }

  @Post(':id/answers')
  answers(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: GuidedAnswersDto) {
    return this.guided.answer(userId, id, dto);
  }

  @Post(':id/documents')
  documents(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.guided.generateDocuments(userId, id);
  }

  @Post(':id/applied')
  applied(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: MarkAppliedDto) {
    return this.guided.markApplied(userId, id, dto);
  }

  @Delete(':id/applied')
  undoApplied(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.guided.undoApplied(userId, id);
  }
}
