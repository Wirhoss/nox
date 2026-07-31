import { sqliteDriver } from './sqlite';

import type { DatabaseDriverName } from '../config';
import type { DatabaseDriver } from './driver';

const drivers: Record<DatabaseDriverName, DatabaseDriver> = {
  sqlite: sqliteDriver,
};

function getDriver(name: DatabaseDriverName): DatabaseDriver {
  return drivers[name];
}

export * from './driver';

export {
  getDriver,
};
