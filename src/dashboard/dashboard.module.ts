import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { SupportModule } from '../support/support.module';
import {
  DashboardController,
  ManagementDashboardController,
  StaffDashboardController,
  TesterDashboardController,
} from './dashboard.controller';

// TokensService comes from its Global module; AdminService and SupportService are exported by their modules.
@Module({
  imports: [AdminModule, SupportModule],
  controllers: [DashboardController, TesterDashboardController, StaffDashboardController, ManagementDashboardController],
})
export class DashboardModule {}
