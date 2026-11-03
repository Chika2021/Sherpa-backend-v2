import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildDataSourceOptions } from './database.config';
import { DatabaseKeepAliveService } from './database-keepalive.service';

/**
 * Connects the app to Supabase Postgres through TypeORM, using DATABASE_URL.
 * (Replaces the old Mongoose DatabaseModule.) Feature modules get their
 * repositories from EntitiesModule.
 *
 * Unlike the MongoDB version, no replica set is needed: Postgres supports
 * transactions natively, which the token ledger and document generation use.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        ...buildDataSourceOptions((key) => config.get<string>(key)),
        retryAttempts: 5,
        retryDelay: 3000,
      }),
    }),
  ],
  providers: [DatabaseKeepAliveService],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
