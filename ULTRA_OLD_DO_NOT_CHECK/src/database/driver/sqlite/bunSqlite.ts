import { Database as BunDatabase } from 'bun:sqlite';

import type { Statement } from 'bun:sqlite';

interface BunSqliteOptions {
  fileMustExist?: boolean;
  readonly?: boolean;
  timeout?: number;
}

class BunSqliteDriver {
  readonly #database: BunDatabase;

  constructor(path: string, options: BunSqliteOptions = {}) {
    const { fileMustExist = false, readonly = false, timeout } = options;

    this.#database = new BunDatabase(path, { create: !fileMustExist, readonly });

    if (timeout !== undefined) {
      this.#database.run(`PRAGMA busy_timeout = ${Number(timeout)}`);
    }
  }

  public close(): void {
    this.#database.close();
  }

  public pragma(source: string): unknown[] {
    const statement = this.#database.prepare(`PRAGMA ${source}`);
    try {
      return statement.all() as unknown[];
    } finally {
      statement.finalize();
    }
  }

  public prepare(query: string): PreparedStatement {
    return new PreparedStatement(this.#database.prepare(query));
  }
}

class PreparedStatement {
  readonly #statement: Statement;

  constructor(statement: Statement) {
    this.#statement = statement;
  }

  public get reader(): boolean {
    return this.#statement.columnNames.length > 0;
  }

  public all(...parameters: unknown[]): unknown[] {
    return this.#statement.all(...(parameters as never[])) as unknown[];
  }

  public run(...parameters: unknown[]): { changes: number; lastInsertRowid: bigint | number } {
    return this.#statement.run(...(parameters as never[]));
  }
}

export {
  BunSqliteDriver,
};
