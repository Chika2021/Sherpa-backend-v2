import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from './database.config';

// Used by the TypeORM CLI (npm run db:sync / migration:*), which runs outside Nest and so reads .env itself.
loadEnv();

const options = buildDataSourceOptions((key) => process.env[key]);

export const AppDataSource = new DataSource({
  ...options,
  // The CLI creates the schema explicitly (db:sync) or through migrations - never implicitly.
  synchronize: false,
  migrations: [join(__dirname, 'migrations', '*{.ts,.js}')],
});

export default AppDataSource;
