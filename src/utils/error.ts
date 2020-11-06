export class DiscordenoError extends Error {
  public name: string;
  constructor(message: string, name?: string) {
    super(message);
    Error.captureStackTrace(this, this.constructor);
    this.name = name ?? "DiscordenoError";
  }
}
