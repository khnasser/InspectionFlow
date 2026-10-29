import { Body, Controller, Get, Inject, NotFoundException, Post } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser, Public, TokenService } from '../../common/auth';
import { APP_CONFIG, AppConfig } from '../../common/config';
import { DbService } from '../../common/db.service';
import { parse } from '../../common/validation';
import { ConfigService } from '../config/config.service';

const devLoginSchema = z.object({ tenantCode: z.string().min(1), email: z.string().email() });

@Controller()
export class SystemController {
  constructor(
    private readonly db: DbService,
    private readonly tokens: TokenService,
    private readonly config: ConfigService,
    @Inject(APP_CONFIG) private readonly appConfig: AppConfig,
  ) {}

  @Public()
  @Get('health')
  async health() {
    await this.db.system('SELECT 1');
    return { status: 'ok', authMode: this.appConfig.authMode, time: new Date().toISOString() };
  }

  /** Development sign-in (AUTH_MODE=dev only). Production uses Keycloak / UAE PASS tokens. */
  @Public()
  @Post('v1/dev/login')
  async devLogin(@Body() body: unknown) {
    if (this.appConfig.authMode !== 'dev') throw new NotFoundException();
    const { tenantCode, email } = parse(devLoginSchema, body);
    const rows = await this.db.system<{ user_id: string; tenant_id: string; display_name: string; roles: string[] }>(
      'SELECT * FROM auth_lookup_user($1, $2)',
      [tenantCode, email.toLowerCase()],
    );
    if (!rows.length) throw new NotFoundException('Unknown user for this tenant');
    const u = rows[0];
    const user: AuthUser = { userId: u.user_id, tenantId: u.tenant_id, roles: u.roles, name: u.display_name };
    return { accessToken: await this.tokens.issueDevToken(user), user };
  }

  @Get('v1/me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }

  /** Offline configuration bundle for the app (processes, violations, rules, checklists). */
  @Get('v1/config/bundle')
  bundle(@CurrentUser() user: AuthUser) {
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.config.bundle(tx));
  }
}
