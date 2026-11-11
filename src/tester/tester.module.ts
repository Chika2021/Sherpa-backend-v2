import { Module } from '@nestjs/common';
import { TesterController } from './tester.controller';

// TokensService comes from its Global module.
@Module({ controllers: [TesterController] })
export class TesterModule {}
