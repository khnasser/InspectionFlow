import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createRemoteJWKSet, jwtVerify, JWTPayload, SignJWT } from 'jose';
import { APP_CONFIG, AppConfig } from './config';
import { DbService } from './db.service';

export interface AuthUser {
  userId: string;
  tenantId: string;
  roles: string[];
  name?: string;
}

const IS_PUBLIC = 'isPublic';
const ROLES = 'roles';

/** Route needs no token (health, dev login, payment webhooks with their own signature). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Route needs at least one of these role codes. */
export const Roles = (...roles: string[]) => SetMetadata(ROLES, roles);

/** Injects the verified caller. */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class TokenService {
  private readonly secret: Uint8Array;
  private readonly jwks?: ReturnType<typeof createRemoteJWKSet>;
  /** Resolved OIDC identities, kept briefly so each request does not hit the database. */
  private readonly cache = new Map<string, { user: AuthUser; expires: number }>();
  static readonly CACHE_MS = 60_000;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig, private readonly db: DbService) {
    this.secret = new TextEncoder().encode(config.devJwtSecret);
    if (config.authMode === 'oidc') {
      const url = config.oidcJwksUrl ?? `${config.oidcIssuer}/protocol/openid-connect/certs`;
      this.jwks = createRemoteJWKSet(new URL(url));
    }
  }

  /** Development tokens only (AUTH_MODE=dev). Production tokens come from Keycloak. */
  async issueDevToken(user: AuthUser, ttlSeconds = 8 * 3600): Promise<string> {
    if (this.config.authMode !== 'dev') throw new ForbiddenException('Dev tokens are disabled');
    return new SignJWT({ tid: user.tenantId, roles: user.roles, name: user.name })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.userId)
      .setIssuer('inspectionflow-dev')
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(this.secret);
  }

  async verify(token: string): Promise<AuthUser> {
    return this.config.authMode === 'dev' ? this.verifyDev(token) : this.verifyOidc(token);
  }

  private async verifyDev(token: string): Promise<AuthUser> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.secret, { issuer: 'inspectionflow-dev', algorithms: ['HS256'] }));
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    const tenantId = payload.tid;
    if (typeof payload.sub !== 'string' || !UUID.test(payload.sub)) {
      throw new UnauthorizedException('Token subject is not a user id');
    }
    if (typeof tenantId !== 'string' || !UUID.test(tenantId)) {
      throw new UnauthorizedException('Token has no tenant');
    }
    return {
      userId: payload.sub,
      tenantId,
      roles: Array.isArray(payload.roles) ? payload.roles.map(String) : [],
      name: typeof payload.name === 'string' ? payload.name : undefined,
    };
  }

  /**
   * Keycloak (and UAE PASS brokered by Keycloak): the token proves who the
   * person is; InspectionFlow decides what they may do. The token's subject is
   * linked to a pre-provisioned user on first sign-in (matched by email), and
   * roles always come from InspectionFlow's own user_roles.
   */
  private async verifyOidc(token: string): Promise<AuthUser> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks!, {
        issuer: this.config.oidcIssuer,
        audience: this.config.oidcAudience,
        algorithms: ['RS256', 'PS256', 'ES256'],
      }));
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    const tenant = payload[this.config.tenantClaim];
    if (typeof payload.sub !== 'string' || !payload.sub) throw new UnauthorizedException('Token has no subject');
    if (typeof tenant !== 'string' || !tenant) throw new UnauthorizedException('Token has no tenant');

    const key = `${tenant}|${payload.sub}`;
    const hit = this.cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.user;

    const email = typeof payload.email === 'string' && payload.email_verified !== false ? payload.email.toLowerCase() : null;
    const rows = await this.db.system<{ user_id: string; tenant_id: string; display_name: string; roles: string[] }>(
      'SELECT * FROM auth_resolve_oidc($1, $2, $3)',
      [tenant, payload.sub, email],
    );
    if (!rows.length) throw new ForbiddenException('No active InspectionFlow account for this identity');
    const user: AuthUser = { userId: rows[0].user_id, tenantId: rows[0].tenant_id, roles: rows[0].roles, name: rows[0].display_name };
    this.cache.set(key, { user, expires: Date.now() + TokenService.CACHE_MS });
    return user;
  }
}

/** Global guard: verifies the bearer token, then checks @Roles. The tenant comes only from the token. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly tokens: TokenService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers?.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Missing bearer token');
    req.user = await this.tokens.verify(header.slice(7));

    const required = this.reflector.getAllAndOverride<string[]>(ROLES, targets);
    if (required?.length && !required.some((r) => req.user.roles.includes(r))) {
      throw new ForbiddenException(`Requires one of: ${required.join(', ')}`);
    }
    return true;
  }
}
