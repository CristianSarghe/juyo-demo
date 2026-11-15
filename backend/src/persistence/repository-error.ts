/** A rejected domain operation, safe to translate to an HTTP problem response. */
export class RepositoryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RepositoryError';
  }
}
