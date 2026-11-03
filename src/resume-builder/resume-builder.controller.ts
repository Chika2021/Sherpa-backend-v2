import { Controller, Delete, Get, Param, Post, Body, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import * as fs from 'fs';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ResumeBuilderService } from './resume-builder.service';
import { GenerateResumeDto } from './dto/generate-resume.dto';

@UseGuards(JwtAuthGuard)
@Controller('resume-builder')
export class ResumeBuilderController {
  constructor(private resumeBuilderService: ResumeBuilderService) {}

  // AI resume maker: generate a polished resume from an existing upload
  // (resumeId) or from freeform details (rawDetails), optionally tailored
  // toward a target role. e.g. body: { "rawDetails": "...", "targetRole": "Product Manager" }
  @Post()
  generate(@CurrentUser('id') userId: string, @Body() dto: GenerateResumeDto) {
    return this.resumeBuilderService.generate(userId, dto);
  }

  @Get()
  findAll(@CurrentUser('id') userId: string) {
    return this.resumeBuilderService.findAllForUser(userId);
  }

  @Get(':id')
  findOne(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.resumeBuilderService.findOne(userId, id);
  }

  @Get(':id/pdf')
  async downloadPdf(@CurrentUser('id') userId: string, @Param('id') id: string, @Res() res: Response) {
    const { path, filename } = await this.resumeBuilderService.getPdfForDownload(userId, id);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    fs.createReadStream(path).pipe(res);
  }

  @Delete(':id')
  remove(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.resumeBuilderService.remove(userId, id);
  }
}
