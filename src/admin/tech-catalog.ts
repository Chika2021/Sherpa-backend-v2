/**
 * What each package in package.json is used for, so the super admin's "App info" screen can group the
 * tools the app is built with. Versions always come from package.json at runtime; this file only adds
 * the category and a one-line purpose. Packages not listed here still appear (under "Other").
 */
export const CATEGORY_ORDER = [
  'Framework & server',
  'Database',
  'Authentication & security',
  'Validation',
  'AI',
  'Documents & files',
  'Scraping & browser automation',
  'Email',
  'Queues & cache',
  'Utilities',
  'Build, test & tooling',
  'Other',
] as const;

type Entry = readonly [category: (typeof CATEGORY_ORDER)[number], purpose: string];

const EXACT: Record<string, Entry> = {
  '@nestjs/common': ['Framework & server', 'NestJS core decorators, pipes, guards and exceptions'],
  '@nestjs/core': ['Framework & server', 'NestJS application runtime, dependency injection and module graph'],
  '@nestjs/platform-express': ['Framework & server', 'HTTP server adapter (Express) and file-upload plumbing'],
  '@nestjs/config': ['Framework & server', 'Loads and validates environment configuration'],
  '@nestjs/serve-static': ['Framework & server', 'Serves the admin dashboard from /public'],
  express: ['Framework & server', 'HTTP server underneath NestJS'],
  'reflect-metadata': ['Framework & server', 'Decorator metadata used by NestJS and TypeORM'],
  rxjs: ['Framework & server', 'Reactive streams: powers the live (Server-Sent Events) feeds'],
  typeorm: ['Database', 'ORM: entities, queries and schema management for Postgres'],
  '@nestjs/typeorm': ['Database', 'NestJS integration for TypeORM'],
  pg: ['Database', 'PostgreSQL driver'],
  '@nestjs/passport': ['Authentication & security', 'NestJS integration for Passport authentication strategies'],
  passport: ['Authentication & security', 'Authentication middleware'],
  'passport-jwt': ['Authentication & security', 'Verifies the JWT bearer token on every protected request'],
  '@nestjs/jwt': ['Authentication & security', 'Issues and verifies JSON Web Tokens'],
  bcryptjs: ['Authentication & security', 'Password hashing'],
  helmet: ['Authentication & security', 'Security-related HTTP headers'],
  '@nestjs/throttler': ['Authentication & security', 'Rate limiting'],
  'class-validator': ['Validation', 'Validates every request body and query (DTOs)'],
  'class-transformer': ['Validation', 'Converts plain request data into typed DTO objects'],
  '@google/genai': ['AI', 'Google Gemini SDK (newer API: speech, live features)'],
  '@google/generative-ai': ['AI', 'Google Gemini SDK (text generation)'],
  pdfkit: ['Documents & files', 'Builds PDF files (resumes, tutorials, internship documents)'],
  'pdf-lib': ['Documents & files', 'Edits and merges existing PDFs'],
  docx: ['Documents & files', 'Generates Word (.docx) documents'],
  mammoth: ['Documents & files', 'Reads text out of uploaded Word files (resume parsing)'],
  multer: ['Documents & files', 'Handles multipart file uploads'],
  playwright: ['Scraping & browser automation', 'Headless browser: assisted job applications and form inspection'],
  cheerio: ['Scraping & browser automation', 'Parses scraped HTML for job sources'],
  nodemailer: ['Email', 'SMTP email sending'],
  '@nestjs/bull': ['Queues & cache', 'NestJS integration for Bull job queues'],
  bull: ['Queues & cache', 'Redis-backed background job queue'],
  ioredis: ['Queues & cache', 'Redis client'],
  uuid: ['Utilities', 'Unique id generation'],
  dotenv: ['Utilities', 'Loads .env files'],
  typescript: ['Build, test & tooling', 'TypeScript compiler'],
  'ts-node': ['Build, test & tooling', 'Runs TypeScript directly (scripts, TypeORM CLI)'],
  '@nestjs/cli': ['Build, test & tooling', 'Nest build and dev server'],
  '@nestjs/testing': ['Build, test & tooling', 'NestJS test utilities'],
  jest: ['Build, test & tooling', 'Test runner'],
  'ts-jest': ['Build, test & tooling', 'TypeScript support for Jest'],
  supertest: ['Build, test & tooling', 'HTTP assertions for end-to-end tests'],
  eslint: ['Build, test & tooling', 'Linting'],
  prettier: ['Build, test & tooling', 'Code formatting'],
};

export function describePackage(name: string): { category: (typeof CATEGORY_ORDER)[number]; purpose: string } {
  const hit = EXACT[name];
  if (hit) return { category: hit[0], purpose: hit[1] };
  if (name.startsWith('@types/')) return { category: 'Build, test & tooling', purpose: 'Type definitions' };
  if (name.startsWith('@typescript-eslint/') || name.startsWith('eslint-')) return { category: 'Build, test & tooling', purpose: 'Linting' };
  if (name.startsWith('@nestjs/')) return { category: 'Framework & server', purpose: 'NestJS module' };
  return { category: 'Other', purpose: '' };
}
