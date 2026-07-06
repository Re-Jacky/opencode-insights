declare module "bun:sqlite" {
  export class Database {
    constructor(path: string);
    run(sql: string, ...params: unknown[]): unknown;
    close(): void;
  }
}
