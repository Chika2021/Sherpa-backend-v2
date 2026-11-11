import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ApplicationsService } from './applications.service';
import { CreateApplicationDto } from './dto/create-application.dto';
import { GenerateForJobDto } from './dto/generate-for-job.dto';
import { RecordResultDto } from './dto/record-result.dto';

@UseGuards(JwtAuthGuard)
@Controller('applications')
export class ApplicationsController {
  constructor(private applicationsService: ApplicationsService) {}

  @Get()
  list(@CurrentUser('id') userId: string) {
    return this.applicationsService.listForUser(userId);
  }

  @Get(':id')
  getOne(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.applicationsService.getOwnedForResponse(userId, id);
  }

  // Step 1 (optional if you want to review before it auto-applies): create the
  // application record and generate the tailored resume + cover letter.
  @Post()
  create(@CurrentUser('id') userId: string, @Body() dto: CreateApplicationDto) {
    return this.applicationsService.create(userId, dto);
  }

  @Post(':id/generate-documents')
  generateDocuments(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.applicationsService.generateDocuments(userId, id);
  }

  // The quick path: just company name + job description (+ optional
  // requirements) - no need to have searched/created a Job first. Creates
  // the Job + Application behind the scenes and immediately returns the
  // generated resume + cover letter (same shape as generate-documents above).
  @Post('generate-for-job')
  generateForJob(@CurrentUser('id') userId: string, @Body() dto: GenerateForJobDto) {
    return this.applicationsService.generateForJobDetails(userId, dto);
  }

  // The browser (Sherpa extension) fills in and submits the application itself and reports the outcome here.
  @Post(':id/result')
  recordResult(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: RecordResultDto) {
    return this.applicationsService.recordClientResult(userId, id, dto);
  }

  // One-shot: generate tailored documents AND attempt to auto-submit the
  // application, filling in every field for you. Returns feedback either way.
  @Post(':id/apply')
  apply(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.applicationsService.generateAndSubmit(userId, id);
  }

  // Delete EVERY application of the current user. Needs ?confirm=yes so a stray call can't wipe the list.
  // Declared before ':id' so "all" is never treated as an id.
  @Delete()
  removeAll(@CurrentUser('id') userId: string, @Query('confirm') confirm?: string) {
    if (confirm !== 'yes') throw new BadRequestException('Add ?confirm=yes to delete all applications.');
    return this.applicationsService.deleteAll(userId);
  }

  @Delete(':id')
  remove(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.applicationsService.deleteOne(userId, id);
  }
}
