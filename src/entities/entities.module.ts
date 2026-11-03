import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ALL_ENTITIES } from './index';

/**
 * Registers a TypeORM repository for every entity exactly once and re-exports
 * it, so a feature module just does `imports: [EntitiesModule]` and can then
 * `@InjectRepository(Anything)`. (This is the TypeORM replacement for the old
 * EntitiesModule - same "one shared registration point" idea.)
 */
const repositories = TypeOrmModule.forFeature(ALL_ENTITIES);

@Module({
  imports: [repositories],
  exports: [repositories],
})
export class EntitiesModule {}
