import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { AuditService } from '../../common/audit.service';
import { AuthUser, CurrentUser, Roles } from '../../common/auth';
import { DbService } from '../../common/db.service';
import { parse } from '../../common/validation';
import {
  clearSignatureSchema,
  decideSchema,
  evaluateSchema,
  respondSchema,
  submitInspectionSchema,
} from './inspection.schemas';
import { DocumentsService } from '../documents/documents.service';
import { InspectionService } from './inspection.service';
import { renderInspectionReport } from './report';
import { ReviewService } from './review.service';

const INSPECTORS = ['INSPECTOR', 'SENIOR_INSPECTOR'];
const REVIEWERS = ['SECTION_MANAGER', 'COMMITTEE', 'DIRECTOR', 'CEO', 'ADMIN'];

@Controller('v1')
export class InspectionController {
  constructor(
    private readonly db: DbService,
    private readonly inspections: InspectionService,
    private readonly reviews: ReviewService,
    private readonly audit: AuditService,
    private readonly documents: DocumentsService,
  ) {}

  @Post('engine/evaluate')
  evaluate(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const input = parse(evaluateSchema, body);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.inspections.evaluate(tx, input));
  }

  @Post('inspections/submit')
  @Roles(...INSPECTORS)
  submit(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const input = parse(submitInspectionSchema, body);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.inspections.submit(tx, user, input));
  }

  @Get('inspections/:id')
  detail(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.tenantId, user.userId, async (tx) => {
      const d = await this.inspections.detail(tx, id);
      const evidence = await this.documents.forInspection(tx, id, d.findings.map((f: { id: string }) => f.id));
      return { ...d, evidence };
    });
  }

  @Get('inspections/:id/report.html')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async report(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query('lang') lang?: string) {
    const d = await this.db.withTenant(user.tenantId, user.userId, (tx) => this.inspections.detail(tx, id));
    return renderInspectionReport(d, lang === 'en' ? 'en' : 'ar');
  }

  @Post('inspections/:id/respond')
  @Roles(...INSPECTORS)
  respond(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { remarks } = parse(respondSchema, body);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.inspections.respond(tx, user, id, remarks));
  }

  @Post('inspections/:id/signature/clear')
  @Roles('SENIOR_INSPECTOR', 'SECTION_MANAGER', 'ADMIN')
  clearSignature(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { reason } = parse(clearSignatureSchema, body);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.inspections.clearSignature(tx, user, id, reason));
  }

  @Get('reviews')
  @Roles(...REVIEWERS)
  pending(@CurrentUser() user: AuthUser) {
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.reviews.pending(tx, user));
  }

  @Post('approvals/:id/decide')
  @Roles(...REVIEWERS)
  decide(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(decideSchema, body);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.reviews.decide(tx, user, id, input));
  }

  @Get('audit/verify')
  @Roles('ADMIN', 'SECTION_MANAGER')
  verifyAudit(@CurrentUser() user: AuthUser) {
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.audit.verify(tx));
  }
}
