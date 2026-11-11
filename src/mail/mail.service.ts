import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

/**
 * Sends email via, in priority order:
 *   1. Brevo HTTPS API   (BREVO_API_KEY)  <- use this on Render
 *   2. Resend HTTPS API  (RESEND_API_KEY)
 *   3. SMTP via nodemailer (SMTP_HOST ...) <- local dev only
 *   4. Log-only if nothing is configured
 *
 * Why HTTPS: Render blocks outbound SMTP (ports 25/465/587) on free
 * instances, so SMTP times out there no matter the credentials. HTTPS (443)
 * is never blocked.
 *
 * Env vars:
 *   MAIL_FROM_EMAIL / SMTP_FROM   sender address (must be verified with the provider)
 *   MAIL_FROM_NAME                optional display name (default "Sherpar")
 *   BREVO_API_KEY | RESEND_API_KEY
 */
/** An application email: plain-text body, the applicant as Reply-To, resume / cover letter attached. */
export interface ApplicationMail {
  to: string;
  subject: string;
  text: string;
  applicantName: string;
  /** The applicant's own address: replies from the employer go here. */
  replyTo: string;
  /** Optional hidden copy to the applicant, so they keep a record of exactly what was sent. */
  bcc?: string;
  attachments: Array<{ filename: string; content: Buffer; mimeType: string }>;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter | null = null;

  private readonly brevoKey?: string;
  private readonly resendKey?: string;
  private readonly fromEmail: string;
  private readonly fromName: string;

  constructor(private config: ConfigService) {
    this.brevoKey = this.config.get<string>('BREVO_API_KEY');
    this.resendKey = this.config.get<string>('RESEND_API_KEY');
    this.fromEmail =
      this.config.get<string>('MAIL_FROM_EMAIL') ||
      this.config.get<string>('SMTP_FROM') ||
      'no-reply@job-apply.local';
    this.fromName = this.config.get<string>('MAIL_FROM_NAME') || 'Sherpar';

    if (this.brevoKey) {
      this.logger.log('Mail provider: Brevo (HTTPS API)');
      return;
    }
    if (this.resendKey) {
      this.logger.log('Mail provider: Resend (HTTPS API)');
      return;
    }

    const host = this.config.get<string>('SMTP_HOST');
    if (!host) {
      this.logger.warn(
        'No mail provider configured - emails will be logged instead of sent. ' +
          'Set BREVO_API_KEY (recommended) or SMTP_* vars.',
      );
      return;
    }

    if (process.env.RENDER) {
      this.logger.warn(
        'SMTP is configured but Render blocks outbound SMTP ports (25/465/587) on free instances. ' +
          'Set BREVO_API_KEY or RESEND_API_KEY to send over HTTPS instead.',
      );
    }

    const user = this.config.get<string>('SMTP_USER');
    const pass = this.config.get<string>('SMTP_PASS');
    this.transporter = nodemailer.createTransport({
      host,
      port: Number(this.config.get('SMTP_PORT')) || 587,
      secure: this.config.get('SMTP_SECURE') === 'true',
      auth: user ? { user, pass } : undefined,
      family: 4, // avoid IPv6 (ENETUNREACH)
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    } as nodemailer.TransportOptions);
  }

  async sendPasswordResetEmail(to: string, resetUrl: string) {
    const subject = 'Reset your password';
    const text = `We received a request to reset your password.

Click the link below to choose a new one (this link expires in 30 minutes):
${resetUrl}

If you didn't request this, you can safely ignore this email.`;
    const html = `<p>We received a request to reset your password.</p>
<p><a href="${resetUrl}">Click here to choose a new password</a> (this link expires in 30 minutes).</p>
<p>If you didn't request this, you can safely ignore this email.</p>`;

    await this.send({ to, subject, text, html });
  }

  /** Generic notification email (helpdesk replies, new-ticket alerts to the admins). Never throws. */
  async sendNotification(to: string, subject: string, text: string): Promise<void> {
    const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = text
      .split(/\n{2,}/)
      .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
      .join('');
    try {
      await this.send({ to, subject, text, html });
    } catch (err) {
      this.logger.error(`Email "${subject}" to ${to} failed: ${(err as Error).message}`);
    }
  }

  /** True when a real provider is configured (otherwise `send` only logs, which must never count as "sent"). */
  canDeliver(): boolean {
    return this.providerName() !== 'none';
  }

  /**
   * Sends a job-application email with the resume / cover letter attached. Unlike `sendNotification` this
   * THROWS on failure and refuses to "send" when no provider is configured, because the caller reports the
   * outcome to the user and a silent log-only send would be a lie. The message goes out from the app's
   * verified sender address, shown as "<Applicant> via <app>", with Reply-To set to the applicant.
   */
  async sendApplicationEmail(msg: ApplicationMail): Promise<void> {
    if (!this.canDeliver()) {
      throw new Error('No mail provider is configured on this server.');
    }
    const clean = (v: string) => v.replace(/[\r\n"<>]+/g, ' ').replace(/\s+/g, ' ').trim();
    const fromName = clean(`${msg.applicantName} via ${this.fromName}`).slice(0, 120) || this.fromName;
    const subject = clean(msg.subject).slice(0, 200);
    const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = msg.text
      .split(/\n{2,}/)
      .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
      .join('');
    const full = { ...msg, applicantName: clean(msg.applicantName) || 'Applicant', subject, fromName, html };

    if (this.brevoKey) return this.sendApplicationViaBrevo(full);
    if (this.resendKey) return this.sendApplicationViaResend(full);
    await this.transporter!.sendMail({
      from: `"${fromName}" <${this.fromEmail}>`,
      to: msg.to,
      bcc: msg.bcc,
      replyTo: `"${clean(msg.applicantName)}" <${msg.replyTo}>`,
      subject,
      text: msg.text,
      html,
      attachments: msg.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.mimeType })),
    });
  }

  private async sendApplicationViaBrevo(m: ApplicationMail & { fromName: string; html: string }) {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': this.brevoKey!, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { email: this.fromEmail, name: m.fromName },
        to: [{ email: m.to }],
        ...(m.bcc ? { bcc: [{ email: m.bcc }] } : {}),
        replyTo: { email: m.replyTo, name: m.applicantName },
        subject: m.subject,
        htmlContent: m.html,
        textContent: m.text,
        attachment: m.attachments.map((a) => ({ name: a.filename, content: a.content.toString('base64') })),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Brevo API ${res.status}: ${await res.text()}`);
  }

  private async sendApplicationViaResend(m: ApplicationMail & { fromName: string; html: string }) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.resendKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: `${m.fromName} <${this.fromEmail}>`,
        to: [m.to],
        ...(m.bcc ? { bcc: [m.bcc] } : {}),
        reply_to: m.replyTo,
        subject: m.subject,
        html: m.html,
        text: m.text,
        attachments: m.attachments.map((a) => ({ filename: a.filename, content: a.content.toString('base64') })),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Resend API ${res.status}: ${await res.text()}`);
  }

  /** Which provider will actually deliver mail (for the admin dashboard). */
  providerName(): 'brevo' | 'resend' | 'smtp' | 'none' {
    if (this.brevoKey) return 'brevo';
    if (this.resendKey) return 'resend';
    return this.transporter ? 'smtp' : 'none';
  }

  private async send(msg: { to: string; subject: string; text: string; html: string }) {
    if (this.brevoKey) return this.sendViaBrevo(msg);
    if (this.resendKey) return this.sendViaResend(msg);

    if (!this.transporter) {
      this.logger.warn(`[dev mode - no mail provider] "${msg.subject}" for ${msg.to}:\n${msg.text}`);
      return;
    }
    await this.transporter.sendMail({
      from: `"${this.fromName}" <${this.fromEmail}>`,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    });
  }

  private async sendViaBrevo(msg: { to: string; subject: string; text: string; html: string }) {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': this.brevoKey!, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { email: this.fromEmail, name: this.fromName },
        to: [{ email: msg.to }],
        subject: msg.subject,
        htmlContent: msg.html,
        textContent: msg.text,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Brevo API ${res.status}: ${await res.text()}`);
  }

  private async sendViaResend(msg: { to: string; subject: string; text: string; html: string }) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.resendKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: `${this.fromName} <${this.fromEmail}>`,
        to: [msg.to],
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Resend API ${res.status}: ${await res.text()}`);
  }
}