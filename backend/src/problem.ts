export class ApiProblemError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function reject(status: number, code: string, message: string): never {
  throw new ApiProblemError(status, code, message);
}
