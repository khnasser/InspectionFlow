import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuditService } from './common/audit.service';
import { AuthGuard, TokenService } from './common/auth';
import { APP_CONFIG, AppConfig, loadConfig } from './common/config';
import { DbService } from './common/db.service';
import { ProblemFilter } from './common/errors.filter';
import { createStorage, STORAGE } from './common/storage';
import { ConfigService } from './modules/config/config.service';
import { DocumentsController } from './modules/documents/documents.controller';
import { DocumentsService } from './modules/documents/documents.service';
import { createPdfRenderer, PDF_RENDERER } from './modules/reports/pdf';
import { ReportsController } from './modules/reports/reports.controller';
import { ReportsService } from './modules/reports/reports.service';
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
        DocumentsController,
        ReportsController,
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
        { provide: STORAGE, useValue: createStorage(config) },
        { provide: PDF_RENDERER, useValue: createPdfRenderer(config) },
        DocumentsService,
        ReportsService,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ProblemFilter },
      ],
    };
  }
}
