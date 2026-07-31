import type { MigrationInterface } from 'typeorm';

type MigrationClass = new () => MigrationInterface;

const migrations: MigrationClass[] = [];

export {
  migrations,
};

export type {
  MigrationClass,
};
