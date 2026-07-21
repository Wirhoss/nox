import { desc, eq, like, or } from 'drizzle-orm';

import { deepResearchTable } from './schema';

import type { NoxDatabase } from './database';
import type { DeepResearchRecord, NewDeepResearchRecord } from './schema';

class DeepResearchStore {
  public constructor(private readonly database: NoxDatabase) {}

  public insert(record: NewDeepResearchRecord): DeepResearchRecord {
    return this.database.insert(deepResearchTable).values(record).returning().get();
  }

  public get(researchId: string): DeepResearchRecord | null {
    return this.database.select().from(deepResearchTable)
      .where(eq(deepResearchTable.researchId, researchId))
      .get() ?? null;
  }

  public list(query?: string): DeepResearchRecord[] {
    const needle = query?.trim();
    return this.database.select().from(deepResearchTable)
      .where(needle ? or(
        like(deepResearchTable.title, `%${needle}%`),
        like(deepResearchTable.objective, `%${needle}%`),
      ) : undefined)
      .orderBy(desc(deepResearchTable.updatedAt))
      .all();
  }
}

export {
  DeepResearchStore,
};
