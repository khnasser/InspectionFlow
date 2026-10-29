import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthUser, CurrentUser, Public, Roles } from '../../common/auth';
import { DbService } from '../../common/db.service';
import { LocalStorage, STORAGE, StoragePort } from '../../common/storage';
import { parse } from '../../common/validation';
import { DocumentsService, initiateUploadSchema } from './documents.service';

@Controller('v1')
export class DocumentsController {
  constructor(
    private readonly db: DbService,
    private readonly documents: DocumentsService,
    @Inject(STORAGE) private readonly storage: StoragePort,
  ) {}

  @Post('documents')
  @Roles('INSPECTOR', 'SENIOR_INSPECTOR')
  initiate(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const input = parse(initiateUploadSchema, body);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.documents.initiate(tx, user, input));
  }

  @Post('documents/:id/complete')
  @HttpCode(200)
  @Roles('INSPECTOR', 'SENIOR_INSPECTOR')
  complete(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.documents.complete(tx, user, id));
  }

  @Get('documents/:id')
  async get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const { key: _key, ...doc } = await this.db.withTenant(user.tenantId, user.userId, (tx) => this.documents.get(tx, id));
    return doc;
  }

  /** Local storage driver only: stands in for S3 presigned PUT / GET URLs. */
  @Public()
  @Put('storage/local/:token')
  @HttpCode(200)
  async localPut(@Param('token') token: string, @Req() req: Request) {
    const local = this.local();
    const grant = local.verify(token, 'PUT');
    if (!grant) throw new ForbiddenException('Invalid or expired upload URL');
    if (req.headers['content-type'] !== grant.t) throw new BadRequestException('Content-Type differs from the declared type');
    try {
      await local.receive(grant, req);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    return { stored: true };
  }

  @Public()
  @Get('storage/local/:token')
  async localGet(@Param('token') token: string, @Res() res: Response) {
    const local = this.local();
    const grant = local.verify(token, 'GET');
    if (!grant) throw new ForbiddenException('Invalid or expired download URL');
    if (!(await local.head(grant.k))) throw new NotFoundException();
    res.setHeader('Content-Type', grant.t ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=300');
    if (grant.f) res.setHeader('Content-Disposition', `inline; filename="${grant.f.replace(/"/g, '')}"`);
    local.stream(grant.k).pipe(res);
  }

  private local(): LocalStorage {
    if (!(this.storage instanceof LocalStorage)) throw new NotFoundException();
    return this.storage;
  }
}
