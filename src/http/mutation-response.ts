/** A committed mutation result; deliberately separate from operational errors. */
export interface MutationResponse {
  readonly statusCode: number;
  readonly body: unknown;
}

export class MutationReplay extends Error {
  readonly response: MutationResponse;
  constructor(response: MutationResponse) {
    super('Replaying a committed mutation');
    this.name = 'MutationReplay';
    this.response = response;
  }
}
