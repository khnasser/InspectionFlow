import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuditService } from './common/audit.service';
import { AuthGuard, TokenService } from './common/auth';
import { APP_CONFIG, AppConfig, loadConfig } from './common/config';
import { DbService } from './common/db.service';
import { ProblemFilter } from './common/errors.filter';
import { ConfigService } from './modules/config/config.service';
import { InspectionController } from './modules/inspections/inspection.controller';
import { InspectionService } from './modules/inspections/inspection.service';
import { ReviewService } from './modules/inspections/review.service';
import { PaymentsController } from './modules/payments/payments.controller';
import { RegistryController } from './modules/registry/registry.controller';
import { SyncController } from './modules/sync/sync.controller';
import { SystemController } from './modules/system/system.controller';
import { AssignmentService } from './modules/tasks/assignment.service';
import { TasksController } from './modules/tasks/tasks.controller';

@Module({})
export class AppModule {
  static register(config: AppConfig = loadConfig()) {
    return {
      module: AppModule,
      controllers: [
        SystemController,
        InspectionController,
        TasksController,
        RegistryController,
        PaymentsController,
        SyncController,
      ],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        DbService,
        TokenService,
        AuditService,
        ConfigService,
        AssignmentService,
        InspectionService,
        ReviewService,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ProblemFilter },
      ],
    };
  }
}
