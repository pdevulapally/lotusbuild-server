import { AppError } from '../http/errors.ts';
import type { EmailSender, VerificationEmail } from './sender.ts';

const BREVO_EMAILS_URL = 'https://api.brevo.com/v3/smtp/email';
const REQUEST_TIMEOUT_MS = 10_000;

function validSender(value: string): boolean {
  return /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(value);
}

export class BrevoEmailSender implements EmailSender {
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
      response = await fetch(BREVO_EMAILS_URL, {
        method: 'POST',
        headers: {
          'api-key': this.#apiKey,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sender: { name: 'LotusBuild', email: this.#from },
          to: [{ email: message.to }],
          subject: 'Your LotusBuild verification code',
          textContent:
            `Your LotusBuild verification code is ${message.code}.\n\n` +
            `It expires in ${message.expiresInMinutes} minutes. If you did not request it, you can ignore this email.`,
          htmlContent:
            '<div style="font-family:Arial,sans-serif;color:#181716;line-height:1.6">' +
            '<p>Your LotusBuild verification code is:</p>' +
            `<p style="font-size:30px;font-weight:700;letter-spacing:8px;margin:20px 0">${message.code}</p>` +
            `<p>It expires in ${message.expiresInMinutes} minutes. If you did not request it, you can ignore this email.</p>` +
            '</div>',
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw this.#deliveryUnavailable();
    }

    if (!response.ok) throw this.#deliveryUnavailable();
  }

  #deliveryUnavailable(): AppError {
    return new AppError({
      code: 'email/delivery-unavailable',
      statusCode: 503,
      message: 'The verification email could not be sent. Try again shortly.',
    });
  }
}
