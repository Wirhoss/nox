import type { Database } from './database';

type StoreFactory<T = unknown> = (database: Database) => T;

const stores = {
  // sessions: (database: Database) => new SessionStore(database),
} satisfies Record<string, StoreFactory>;

type StoreRegistry = typeof stores;
type StoreKey = keyof StoreRegistry;
type StoreMap = { [K in StoreKey]: ReturnType<StoreRegistry[K]> };

export {
  stores,
};

export type {
  StoreFactory,
  StoreKey,
  StoreMap,
  StoreRegistry,
};
