import { nanoid } from 'nanoid';
import { z } from 'zod';

import { closeDatabase, DeepResearchStore, openDatabase } from '../database';
import { NotFoundError } from '../errors';
import { createLogger } from '../logger';

import type { DeepResearchRecord, NoxDatabase } from '../database';

const logger = createLogger('deep-research');

const createDeepResearchSchema = z.object({
  title: z.string().trim().min(1).max(120),
  objective: z.string().trim().min(1).max(4_000),
});

type CreateDeepResearch = z.infer<typeof createDeepResearchSchema>;
type NoxGlobal = typeof globalThis & { noxDeepResearchRegistry?: DeepResearchRegistry };

class DeepResearchRegistry {
  private database?: NoxDatabase;
  private store?: DeepResearchStore;

  private constructor() {}

  public static get instance(): DeepResearchRegistry {
    const globalState = globalThis as NoxGlobal;
    globalState.noxDeepResearchRegistry ??= new DeepResearchRegistry();
    return globalState.noxDeepResearchRegistry;
  }

  public get initialized(): boolean {
    return this.store !== undefined;
  }

  public init(databaseFile: string): void {
    if (this.store) return;
    this.database = openDatabase(databaseFile);
    this.store = new DeepResearchStore(this.database);
    logger.info({ databaseFile }, 'Deep Research registry initialized.');
  }

  public create(input: CreateDeepResearch): DeepResearchRecord {
    const research = this.requireStore().insert({
      researchId: nanoid(),
      title: input.title,
      objective: input.objective,
      status: 'draft',
    });
    logger.info({ researchId: research.researchId }, 'Deep Research draft created.');
    return research;
  }

  public get(researchId: string): DeepResearchRecord {
    const research = this.requireStore().get(researchId);
    if (!research) throw new NotFoundError(`Deep Research with id ${researchId} not found.`);
    return research;
  }

  public list(query?: string): DeepResearchRecord[] {
    return this.requireStore().list(query);
  }

  public close(): void {
    if (this.database) closeDatabase(this.database);
    this.database = undefined;
    this.store = undefined;
  }

  private requireStore(): DeepResearchStore {
    if (!this.store) throw new Error('DeepResearchRegistry not initialized.');
    return this.store;
  }
}

export {
  createDeepResearchSchema,
  DeepResearchRegistry,
};

export type {
  CreateDeepResearch,
};
