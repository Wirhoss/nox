import { describe, expect, test } from 'bun:test';

import { BunSqliteDriver } from './bunSqlite';

describe('BunSqliteDriver', () => {
  test('pragma returns rows', () => {
    const database = new BunSqliteDriver(':memory:');
    try {
      expect(database.pragma('journal_mode')).toEqual([{ journal_mode: 'memory' }]);
    } finally {
      database.close();
    }
  });

  test('reader distinguishes row-returning statements from writes', () => {
    const database = new BunSqliteDriver(':memory:');
    try {
      database.prepare('CREATE TABLE t (id integer PRIMARY KEY, v text)').run();

      expect(database.prepare('SELECT * FROM t').reader).toBe(true);
      expect(database.prepare('INSERT INTO t (v) VALUES (?)').reader).toBe(false);
    } finally {
      database.close();
    }
  });

  test('run reports changes and lastInsertRowid', () => {
    const database = new BunSqliteDriver(':memory:');
    try {
      database.prepare('CREATE TABLE t (id integer PRIMARY KEY, v text)').run();

      const inserted = database.prepare('INSERT INTO t (v) VALUES (?)').run('a');
      expect(inserted.changes).toBe(1);
      expect(Number(inserted.lastInsertRowid)).toBe(1);

      const updated = database.prepare('UPDATE t SET v = ?').run('b');
      expect(updated.changes).toBe(1);
    } finally {
      database.close();
    }
  });

  test('all binds positional parameters', () => {
    const database = new BunSqliteDriver(':memory:');
    try {
      database.prepare('CREATE TABLE t (id integer PRIMARY KEY, v text)').run();
      database.prepare('INSERT INTO t (v) VALUES (?)').run('a');
      database.prepare('INSERT INTO t (v) VALUES (?)').run('b');

      expect(database.prepare('SELECT v FROM t WHERE v = ?').all('b')).toEqual([{ v: 'b' }]);
    } finally {
      database.close();
    }
  });

  test('applies the busy timeout passed as a constructor option', () => {
    const database = new BunSqliteDriver(':memory:', { timeout: 1234 });
    try {
      expect(database.pragma('busy_timeout')).toEqual([{ timeout: 1234 }]);
    } finally {
      database.close();
    }
  });

  test('fileMustExist refuses to create a missing file', () => {
    expect(() => new BunSqliteDriver('/nonexistent/nox-missing.db', { fileMustExist: true }))
      .toThrow();
  });
});
