/** Transport-neutral domain failure converted to an HTTP Problem by the mock adapter. */
export class MockRepositoryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MockRepositoryError';
  }
}
