export interface VerificationEmail {
  readonly to: string;
  readonly code: string;
  readonly expiresInMinutes: number;
}

export interface EmailSender {
  sendVerificationCode(message: VerificationEmail): Promise<void>;
}
