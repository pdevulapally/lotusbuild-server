import { AppError } from '../http/errors.ts';
import type { EmailSender, VerificationEmail } from './sender.ts';

const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
const REQUEST_TIMEOUT_MS = 10_000;

function validSender(value: string): boolean {
  return /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(value);
}

export class ResendEmailSender implements EmailSender {
  readonly #apiKey: string;
  readonly #from: string;

  constructor(apiKey: string, from: string) {
    if (!validSender(from)) {
      throw new Error('EMAIL_VERIFICATION_FROM must be a valid email address.');
    }
    this.#apiKey = apiKey;
    this.#from = from;
  }

  async sendVerificationCode(message: VerificationEmail): Promise<void> {
    let response: Response;
    try {
      response = await fetch(RESEND_EMAILS_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': message.idempotencyKey,
        },
        body: JSON.stringify({
          from: `LotusBuild <${this.#from}>`,
          to: [message.to],
          subject: 'Your LotusBuild verification code',
          text:
            `Your LotusBuild verification code is ${message.code}.\n\n` +
            `It expires in ${message.expiresInMinutes} minutes. If you did not request it, you can ignore this email.`,
          html:
            '<div style="font-family:Arial,sans-serif;color:#181716;line-height:1.6">' +
            '<p>Your LotusBuild verification code is:</p>' +
            `<p style="font-size:30px;font-weight:700;letter-spacing:8px;margin:20px 0">${message.code}</p>` +
            `<p>It expires in ${message.expiresInMinutes} minutes. If you did not request it, you can ignore this email.</p>` +
            '</div>',
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new AppError({
        code: 'email/delivery-unavailable',
        statusCode: 503,
        message: 'The verification email could not be sent. Try again shortly.',
        cause,
      });
    }

    if (!response.ok) {
      throw new AppError({
        code: 'email/delivery-unavailable',
        statusCode: 503,
        message: 'The verification email could not be sent. Try again shortly.',
      });
    }
  }
}
