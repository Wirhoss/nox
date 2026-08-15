import { nanoid } from 'nanoid';

import { AgentRegistry } from '../agent/registry';
import { closeDatabase, DeliberationStore, openDatabase } from '../database';
import { ConflictError, NotFoundError } from '../errors';
import { createLogger } from '../logger';

import { DeliberationRunner } from './runner';
import { deliberationConfigurationSchema } from './schemas';

import type { DeliberationDetail, DeliberationRecord, NoxDatabase } from '../database';
import type { DeliberationJob } from './runner';
import type { CreateDeliberation, DeliberationConfiguration } from './schemas';

const logger = createLogger('deliberation');

type NoxGlobal = typeof globalThis & { noxDeliberationRegistry?: DeliberationRegistry };
type RunningDeliberation = DeliberationJob & {
  promise: Promise<void>;
};

/**
 * Owns deliberation persistence and the lifecycle of running jobs. The round-by-round
 * execution itself lives in {@link DeliberationRunner}.
 */
class DeliberationRegistry {
  private database?: NoxDatabase;
  private store?: DeliberationStore;
  private readonly jobs = new Map<string, RunningDeliberation>();

  private constructor() {}

  public static get instance(): DeliberationRegistry {
    const globalState = globalThis as NoxGlobal;
    globalState.noxDeliberationRegistry ??= new DeliberationRegistry();
    return globalState.noxDeliberationRegistry;
  }

  public get initialized(): boolean {
    return this.store !== undefined;
  }

  public init(databaseFile: string): void {
    if (this.store) return;
    this.database = openDatabase(databaseFile);
    this.store = new DeliberationStore(this.database);
    this.store.recoverInterrupted();
    logger.info({ databaseFile }, 'Deliberation registry initialized.');
  }

  public create(input: CreateDeliberation): DeliberationRecord {
    this.validateConfiguration(input);
    const deliberation = this.requireStore().insert({
      deliberationId: nanoid(),
      moderatorBlueprintId: input.moderatorBlueprintId,
      participantBlueprintIds: input.participantBlueprintIds,
      question: input.question,
      rounds: input.rounds,
      status: 'draft',
      title: input.title,
    });
    logger.info({ deliberationId: deliberation.deliberationId }, 'Deliberation draft created.');
    return deliberation;
  }

  public configure(deliberationId: string, input: DeliberationConfiguration): DeliberationDetail {
    this.validateConfiguration(input);
    const deliberation = this.get(deliberationId);
    if (deliberation.status === 'active' || deliberation.status === 'completed') {
      throw new ConflictError('Only a draft, failed, or cancelled deliberation can be configured.');
    }
    const updated = this.requireStore().updateConfiguration(deliberationId, input);
    if (!updated) throw new NotFoundError(`Deliberation with id ${deliberationId} not found.`);
    return { ...updated, turns: this.requireStore().listTurns(deliberationId) };
  }

  public get(deliberationId: string): DeliberationRecord {
    const deliberation = this.requireStore().get(deliberationId);
    if (!deliberation) throw new NotFoundError(`Deliberation with id ${deliberationId} not found.`);
    return deliberation;
  }

  public getDetail(deliberationId: string): DeliberationDetail {
    const deliberation = this.requireStore().getDetail(deliberationId);
    if (!deliberation) throw new NotFoundError(`Deliberation with id ${deliberationId} not found.`);
    return deliberation;
  }

  public list(query?: string): DeliberationRecord[] {
    return this.requireStore().list(query);
  }

  public start(deliberationId: string): DeliberationDetail {
    const deliberation = this.get(deliberationId);
    if (deliberation.status === 'active' || this.jobs.has(deliberationId)) {
      throw new ConflictError('This deliberation is already running.');
    }
    if (deliberation.status === 'completed') {
      throw new ConflictError('A completed deliberation cannot be started again.');
    }
    this.validateConfiguration({
      moderatorBlueprintId: deliberation.moderatorBlueprintId ?? '',
      participantBlueprintIds: deliberation.participantBlueprintIds,
      rounds: deliberation.rounds,
    });

    const active = this.requireStore().begin(deliberationId);
    if (!active) throw new NotFoundError(`Deliberation with id ${deliberationId} not found.`);

    const job: RunningDeliberation = {
      cancelled: false,
      promise: Promise.resolve(),
      sessions: new Set(),
    };
    this.jobs.set(deliberationId, job);
    job.promise = new DeliberationRunner(this.requireStore(), active, job).run()
      .catch((error: unknown) => {
        if (job.cancelled) {
          this.requireStore().cancel(deliberationId);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        this.requireStore().fail(deliberationId, message);
        logger.error({ err: error, deliberationId }, 'Deliberation failed.');
      })
      .finally(() => this.jobs.delete(deliberationId));

    logger.info({ deliberationId }, 'Deliberation started.');
    return this.getDetail(deliberationId);
  }

  public async cancel(deliberationId: string): Promise<DeliberationDetail> {
    const deliberation = this.get(deliberationId);
    const job = this.jobs.get(deliberationId);
    if (deliberation.status !== 'active' || !job) {
      throw new ConflictError('Only an active deliberation can be cancelled.');
    }
    job.cancelled = true;
    await Promise.all([...job.sessions].map((session) => session.abort()));
    this.requireStore().cancel(deliberationId);
    logger.info({ deliberationId }, 'Deliberation cancelled.');
    return this.getDetail(deliberationId);
  }

  public async close(): Promise<void> {
    for (const job of this.jobs.values()) {
      job.cancelled = true;
      await Promise.all([...job.sessions].map((session) => session.abort()));
    }
    await Promise.all([...this.jobs.values()].map((job) => job.promise));
    this.jobs.clear();
    if (this.database) closeDatabase(this.database);
    this.database = undefined;
    this.store = undefined;
  }

  private validateConfiguration(input: DeliberationConfiguration): void {
    if (input.participantBlueprintIds.length < 2) {
      throw new ConflictError('Select at least two participant blueprints.');
    }
    if (input.participantBlueprintIds.length > 8) {
      throw new ConflictError('Select no more than eight participant blueprints.');
    }
    if (!input.moderatorBlueprintId.trim()) {
      throw new ConflictError('Select a moderator blueprint.');
    }
    if (input.rounds < 1 || input.rounds > 100) {
      throw new ConflictError('Maximum rounds must be between 1 and 100.');
    }
    const parsed = deliberationConfigurationSchema.safeParse(input);
    if (!parsed.success) throw new ConflictError(parsed.error.issues[0]?.message ?? 'Invalid deliberation configuration.');
    for (const blueprintId of [...input.participantBlueprintIds, input.moderatorBlueprintId]) {
      if (!AgentRegistry.instance.getBlueprint(blueprintId)) {
        throw new NotFoundError(`Agent blueprint with id ${blueprintId} not found.`);
      }
    }
  }

  private requireStore(): DeliberationStore {
    if (!this.store) throw new Error('DeliberationRegistry not initialized.');
    return this.store;
  }
}

export {
  DeliberationRegistry,
};
