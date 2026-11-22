import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  register(@Body() dto: RegisterDto, @Req() req: any) {
    return this.authService.register(dto, req);
  }

  // Confirms the email address from the link in the verification email. Public: the link works without being signed in.
  @Post('verify-email')
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.authService.verifyEmail(dto);
  }

  // Sends a fresh verification email to the signed-in user (once a minute at most).
  @UseGuards(JwtAuthGuard)
  @Post('resend-verification')
  resendVerification(@CurrentUser('id') userId: string) {
    return this.authService.resendVerification(userId);
  }

  @Post('login')
  login(@Body() dto: LoginDto, @Req() req: any) {
    return this.authService.login(dto, req);
  }

  // Dashboard sign-in for TESTER / STAFF / ADMIN / MANAGEMENT / SUPER_ADMIN. Returns `dashboard.path` to redirect to.
  // SUPER_ADMIN is refused here when the request comes from the frontend app (backend-only account).
  @Post('admin-login')
  adminLogin(@Body() dto: LoginDto, @Req() req: any) {
    return this.authService.adminLogin(dto, req);
  }

  // Optional, but makes "time spent in the app" exact: call it when the user taps Sign out.
  @UseGuards(JwtAuthGuard)
  @Post('logout')
  logout(@CurrentUser('id') userId: string) {
    return this.authService.logout(userId);
  }

  // Optional: the app can ping this about once a minute while it is open and visible. Any authenticated
  // request already counts as activity - this just keeps the visit alive when the user is only reading.
  @UseGuards(JwtAuthGuard)
  @Post('heartbeat')
  heartbeat() {
    return { ok: true };
  }

  // Update your password while logged in.
  @UseGuards(JwtAuthGuard)
  @Post('change-password')
  changePassword(@CurrentUser('id') userId: string, @Body() dto: ChangePasswordDto) {
    return this.authService.changePassword(userId, dto);
  }

  // Kick off password recovery: emails a reset link if the address is registered.
  @Post('forgot-password')
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  // Finish password recovery using the token from the emailed link.
  @Post('reset-password')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }
}
