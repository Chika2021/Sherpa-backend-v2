import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { v4 as uuid } from 'uuid';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ResumesService } from './resumes.service';
import { isSupportedResumeFile, SUPPORTED_RESUME_MESSAGE } from './resume-file-types';

@UseGuards(JwtAuthGuard)
@Controller('resumes')
export class ResumesController {
  constructor(private resumesService: ResumesService) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: process.env.UPLOAD_DIR || './uploads',
        filename: (_req, file, cb) => {
          cb(null, `${uuid()}${extname(file.originalname)}`);
        },
      }),
      limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
      // Browsers/OSes often send a wrong or empty MIME type (e.g. application/octet-stream for PDFs/DOCX),
      // so the extension is checked as well as the MIME type.
      fileFilter: (_req, file, cb) => {
        if (isSupportedResumeFile(file.originalname, file.mimetype)) return cb(null, true);
        cb(new BadRequestException(SUPPORTED_RESUME_MESSAGE), false);
      },
    }),
  )
  upload(@CurrentUser('id') userId: string, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException(`No file received. Send it as multipart field "file". ${SUPPORTED_RESUME_MESSAGE}`);
    return this.resumesService.uploadAndParse(userId, file);
  }

  @Get()
  findAll(@CurrentUser('id') userId: string) {
    return this.resumesService.findAllForUser(userId);
  }

  @Get(':id')
  findOne(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.resumesService.findOne(userId, id);
  }

  @Patch(':id/primary')
  setPrimary(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.resumesService.setPrimary(userId, id);
  }

  @Delete(':id')
  remove(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.resumesService.remove(userId, id);
  }
}
