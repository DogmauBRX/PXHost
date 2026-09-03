import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ForgotPasswordDto, ResetPasswordDto } from './dto/password-reset.dto';
import { Public } from './decorators/public.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import type { AuthenticatedUser } from './guards/jwt-auth.guard';
import { PrismaService } from '../../core/prisma/prisma.service';

// __Host- (not used here) mandates Path=/ with NO exceptions — that's
// incompatible with deliberately scoping this cookie to /api/auth
// (defense-in-depth: it's never sent on any other request). __Secure-
// only requires the Secure attribute, so it's the correct prefix for a
// narrower path. Found live (real browser, not curl/inject): with
// __Host- + Path=/api/auth, the browser silently drops the Set-Cookie
// header on every login/refresh — refresh-token persistence across a
// page reload never actually worked, in dev OR prod, since no version of
// this cookie's attributes has ever satisfied __Host-'s own Path
// requirement.
const REFRESH_COOKIE_NAME = '__Secure-panel_refresh';
const REFRESH_COOKIE_PATH = '/api/auth';

@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const result = await this.auth.login(dto.email, dto.password, requestMeta(req));
    setRefreshCookie(reply, result.refreshToken, result.refreshExpiresAt);
    return {
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      user: result.user,
    };
  }

  // Commercial site — public self-signup, behind ALLOW_PUBLIC_REGISTRATION
  // (default off, see AuthService.register's doc comment). @Public()
  // regardless of the flag: the flag decides whether the SERVICE accepts
  // the request (404 when off), not whether the JWT guard does — a
  // disabled feature must still read as "not found," never "unauthorized."
  @Public()
  @Post('register')
  @HttpCode(HttpStatus.OK)
  async register(@Body() dto: RegisterDto, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const result = await this.auth.register(dto, requestMeta(req));
    setRefreshCookie(reply, result.refreshToken, result.refreshExpiresAt);
    return {
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      user: result.user,
    };
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const presented = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE_NAME];
    if (!presented) throw new UnauthorizedException('Missing refresh token');

    const result = await this.auth.refresh(presented, requestMeta(req));
    setRefreshCookie(reply, result.refreshToken, result.refreshExpiresAt);
    return {
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      user: result.user,
    };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { allDevices?: boolean },
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.auth.logout(user.sessionId, user.jti, Boolean(body?.allDevices), user.id);
    reply.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
  }

  // Client account management, Fase 1. Always the same generic response
  // regardless of whether the email exists — see AuthService
  // .requestPasswordReset's own doc comment for the anti-enumeration
  // reasoning (both the message AND the response latency have to stay
  // uniform, not just the message).
  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: FastifyRequest) {
    await this.auth.requestPasswordReset(dto.email, requestMeta(req));
    return { message: 'Se existir uma conta associada a este email, enviaremos instruções para recuperar seu acesso.' };
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() dto: ResetPasswordDto, @Req() req: FastifyRequest) {
    await this.auth.resetPassword(dto.token, dto.newPassword, dto.confirmPassword, requestMeta(req));
    return { message: 'Senha alterada com sucesso.' };
  }

  @Post('me')
  @HttpCode(HttpStatus.OK)
  async me(@CurrentUser() user: AuthenticatedUser) {
    const record = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { id: true, email: true, username: true, globalRole: true, language: true, totpEnabledAt: true },
    });
    return {
      id: record.id,
      email: record.email,
      username: record.username,
      globalRole: record.globalRole,
      locale: record.language,
      twoFactorEnabled: Boolean(record.totpEnabledAt),
    };
  }

}

function requestMeta(req: FastifyRequest): { ip: string; userAgent: string | null } {
  return { ip: req.ip, userAgent: req.headers['user-agent'] ?? null };
}

function setRefreshCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
  reply.setCookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    // Always true, not isProd()-conditional: the __Secure- prefix
    // requires it unconditionally, and browsers treat http://localhost
    // as a secure context for this purpose, so dev over plain HTTP still
    // works.
    secure: true,
    sameSite: 'lax',
    path: REFRESH_COOKIE_PATH,
    expires: expiresAt,
  });
}
