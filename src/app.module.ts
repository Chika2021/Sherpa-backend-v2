import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { BullModule } from '@nestjs/bull';

import { DatabaseModule } from './database/database.module';
import { StorageModule } from './storage/storage.module';
import { MailModule } from './mail/mail.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ResumesModule } from './resumes/resumes.module';
import { AiModule } from './ai/ai.module';
import { JobsModule } from './jobs/jobs.module';
import { ApplicationsModule } from './applications/applications.module';
import { DocumentsModule } from './documents/documents.module';
import { ResumeBuilderModule } from './resume-builder/resume-builder.module';
import { TokensModule } from './tokens/tokens.module';
import { PaymentsModule } from './payments/payments.module';
import { CredentialsModule } from './credentials/credentials.module';
import { InterviewPrepModule } from './interview-prep/interview-prep.module';
import { SkillsModule } from './skills/skills.module';
import { AudioModule } from './audio/audio.module';
import { JobSourceSettingsModule } from './job-sources/job-source-settings.module';
import { AiTrainingJobsModule } from './ai-training-jobs/ai-training-jobs.module';
import { HealthModule } from './health/health.module';
import { RealtimeModule } from './realtime/realtime.module';
import { AdminModule } from './admin/admin.module';
import { SupportModule } from './support/support.module';
import { ChatbotModule } from './chatbot/chatbot.module';
import { TesterModule } from './tester/tester.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BullModule.forRoot({
      redis: {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: Number(process.env.REDIS_PORT) || 6379,
      },
    }),
    ServeStaticModule.forRoot(
      {
        rootPath: join(process.cwd(), process.env.GENERATED_DIR || 'generated'),
        serveRoot: '/files',
      },
      // Admin dashboard (open https://<your-api-host>/admin) and the embeddable contact/chatbot widget
      // (<script src="https://<your-api-host>/widget/sherpar-widget.js">).
      { rootPath: join(process.cwd(), 'public', 'admin'), serveRoot: '/admin' },
      { rootPath: join(process.cwd(), 'public', 'widget'), serveRoot: '/widget' },
    ),
    DatabaseModule,
    HealthModule,
    StorageModule,
    MailModule,
    AuthModule,
    UsersModule,
    ResumesModule,
    AiModule,
    JobsModule,
    ApplicationsModule,
    DocumentsModule,
    ResumeBuilderModule,
    TokensModule,
    PaymentsModule,
    CredentialsModule,
    InterviewPrepModule,
    SkillsModule,
    AudioModule,
    JobSourceSettingsModule,
    AiTrainingJobsModule,
    RealtimeModule,
    AdminModule,
    SupportModule,
    ChatbotModule,
    TesterModule,
  ],
})
export class AppModule {}
