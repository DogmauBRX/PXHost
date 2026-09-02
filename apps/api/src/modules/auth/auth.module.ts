import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { SessionRevocationService } from './session-revocation.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    AuditModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SESSION_SECRET'),
        // Algorithm is pinned here, once, globally — every sign/verify
        // call in TokenService inherits it. There is no code path in this
        // module that lets a caller choose a different algorithm.
        signOptions: { algorithm: 'HS512' },
        verifyOptions: { algorithms: ['HS512'] },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, PasswordService, TokenService, SessionRevocationService, JwtAuthGuard],
  exports: [AuthService, PasswordService, TokenService, SessionRevocationService, JwtAuthGuard],
})
export class AuthModule {}
