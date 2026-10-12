export interface VerificationEmail {
  readonly to: string;
  readonly code: string;
  readonly expiresInMinutes: number;
  readonly idempotencyKey: string;
}

export interface EmailSender {
  sendVerificationCode(message: VerificationEmail): Promise<void>;
}
