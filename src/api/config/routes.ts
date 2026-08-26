import { Elysia } from 'elysia';
import { z } from 'zod';

import { isConfigError } from '../../config/error';
import { entryIdSchema } from '../../config/loader';
import { authGuard } from '../auth/guard';
import { BlueprintReferenceError } from './blueprints';
import { BrokerReferenceError } from './brokers';
import { type ConfigStore, ContributionTypeChangeError, EntryInUseError } from './store';

import type { ConfigKey } from '../../config/sections';
import type { AuthStore } from '../auth/store';

/** No section is called that. */
const NO_SECTION = { error: 'section_not_found' } as const;

/** No entry of that name is configured in the section. */
const NO_ENTRY = { error: 'entry_not_found' } as const;

/** One already is, and a create is not a replace. */
const EXISTS = { error: 'entry_exists' } as const;

const sectionParamsSchema = z.object({ section: z.string() });

/**
 * An entry's ID is a name, and for a directory section it is also the name of
 * its file. It is the loader's own alphabet rather than a second dialect of the
 * same idea: what this surface accepts is exactly what a hand-written file can
 * be called.
 */
const entryParamsSchema = z.object({
  entryId: entryIdSchema,
  section: z.string(),
});

/**
 * An entry arrives as whatever JSON object the client sent and is judged by the
 * section's own schema, exactly as the loader judges the file on disk.
 * Restating any of those shapes here would be a second definition of the same
 * thing, and the two would diverge the first time either moved.
 */
const bodySchema = z.record(z.string(), z.unknown());

interface ConfigRoutesOptions {
  readonly config: ConfigStore;
  readonly store: AuthStore;
}

interface Refusal {
  readonly body: Record<string, unknown>;
  readonly status: 409 | 422 | 503;
}

/**
 * Turns the failures that are the client's business into answers, and lets
 * everything else through. A disk that cannot be written is not a bad request,
 * and reporting it as one would send the operator looking at their JSON.
 */
function refusal(error: unknown): Refusal | undefined {
  if (error instanceof EntryInUseError) {
    return {
      body: { detail: error.message, error: 'entry_in_use', reasons: error.reasons },
      status: 409,
    };
  }
  if (error instanceof ContributionTypeChangeError) {
    return { body: { detail: error.message, error: 'contribution_type_change' }, status: 409 };
  }
  if (error instanceof BlueprintReferenceError || error instanceof BrokerReferenceError) {
    return {
      body: { detail: error.message, error: 'unknown_reference', problems: error.problems },
      status: 422,
    };
  }
  if (isConfigError(error)) {
    if (error.code === 'invalid_schema' || error.code === 'unknown_keys') {
      return { body: { detail: error.message, error: 'invalid_config' }, status: 422 };
    }
    if (error.code === 'unresolved') {
      return { body: { detail: error.message, error: 'section_unresolved' }, status: 503 };
    }
  }
  return undefined;
}

/** A section holding one document has no entries to address. */
function runtime(config: ConfigStore): {
  readonly revertAvailable?: boolean;
  readonly runtime?: ReturnType<ConfigStore['runtimeStatuses']>;
} {
  const statuses = config.runtimeStatuses();
  return statuses.length === 0 && !config.revertAvailable
    ? {}
    : { revertAvailable: config.revertAvailable, runtime: statuses };
}

function notEntried(section: string): Record<string, string> {
  return {
    detail: `The ${section} section holds one document, not named entries.`,
    error: 'section_has_no_entries',
  };
}

/**
 * Configuration as an administrable surface — all of it, through one door: the
 * sections, their documents, and the entries inside the sections that hold
 * several. The blueprints are among those entries and not beside them, because
 * a second route onto the same files is a second set of checks to keep in step
 * with this one.
 *
 * Every write reports `restartRequired` from the section or field-level runtime
 * policy rather than assuming it. Hot generations and infrastructure changes
 * therefore share one surface without either being mislabeled.
 *
 * Authenticated throughout. A blueprint is the whole of what an agent will do,
 * providers name the endpoints Nox talks to, tool sets decide what tools exist
 * at all, and `app.json` holds the token lifetimes protecting this very route.
 */
function createConfigRoutes(options: ConfigRoutesOptions) {
  const { config, store } = options;

  /** The section a URL segment names, or nothing when it names none. */
  function keyOf(section: string): ConfigKey | undefined {
    return config.resolve(section);
  }

  return (
    new Elysia({ name: 'nox.api.config.routes' })
      .use(authGuard(store))

      /**
       * What is configurable at all, and the shape of each section. A surface
       * that reads this knows which sections it may write whole, which hold
       * entries, and which cannot be read yet — without hardcoding the set.
       *
       */
      .get(
        '/config',
        () => ({
          revertAvailable: config.revertAvailable,
          runtime: config.runtimeStatuses(),
          sections: config.sections(),
        }),
        {
          authenticated: true,
        },
      )

      /** Desired configuration compared with the generations actually serving work. */
      .get(
        '/config/runtime',
        () => ({
          components: config.runtimeStatuses(),
          revertAvailable: config.revertAvailable,
        }),
        {
          authenticated: true,
        },
      )

      /** Re-reads mounted files explicitly, retaining each last valid section on failure. */
      .post(
        '/config/reload',
        async () => {
          await config.reloadConfiguration();
          return {
            revertAvailable: config.revertAvailable,
            runtime: config.runtimeStatuses(),
            sections: config.sections(),
          };
        },
        { authenticated: true },
      )

      /** Retries every failed or unavailable candidate without rewriting configuration. */
      .post(
        '/config/runtime/retry',
        async () => {
          await config.retryRuntime();
          return {
            components: config.runtimeStatuses(),
            revertAvailable: config.revertAvailable,
          };
        },
        { authenticated: true },
      )

      /** Restores the desired document that preceded the latest failed activation. */
      .post(
        '/config/runtime/revert',
        async () => {
          await config.revertRuntime();
          return {
            components: config.runtimeStatuses(),
            revertAvailable: config.revertAvailable,
          };
        },
        { authenticated: true },
      )

      /**
       * Runtime capability inventory for blueprint editors. This is deliberately
       * separate from toolsets.json: the configured document says which instance
       * and kind exist, while its factory says which tools that instance exposes.
       */
      .get('/capabilities/tool-sets', async () => ({ toolSets: await config.toolSetInventory() }), {
        authenticated: true,
      })

      /**
       * The kinds a tool set may be, with each kind's own schema. An editor
       * builds its form from this instead of carrying a copy of what one
       * extension's configuration looks like — which is what let the previous
       * one keep offering fields the contribution had already stopped accepting.
       */
      .get('/capabilities/tool-set-types', () => ({ toolSetTypes: config.toolSetTypes() }), {
        authenticated: true,
      })

      .get(
        '/config/:section',
        ({ params, status }) => {
          const key = keyOf(params.section);
          if (key === undefined) return status(404, NO_SECTION);

          try {
            return { ...config.summary(key), value: config.read(key) };
          } catch (error) {
            const refused = refusal(error);
            if (refused === undefined) throw error;
            return status(refused.status, refused.body);
          }
        },
        { authenticated: true, params: sectionParamsSchema },
      )

      /**
       * Replaces one section whole. Not a merge, for the reason an entry is not
       * merged either: these documents are read as one by everything that
       * consumes them, and a patch that dropped `providers.main` while meaning
       * to leave it alone would take an agent's endpoint away. Changing one
       * entry without resending the others is what the entry routes are for.
       */
      .put(
        '/config/:section',
        async ({ body, params, status }) => {
          const key = keyOf(params.section);
          if (key === undefined) return status(404, NO_SECTION);

          const summary = config.summary(key);
          if (!summary.writable) {
            return status(409, {
              detail: `${summary.name} is a directory of entries; write them one at a time.`,
              error: 'section_not_writable',
            });
          }

          try {
            const saved = await config.write(key, body);
            return {
              ...summary,
              restartRequired: saved.restartRequired,
              ...runtime(config),
              value: saved.value,
            };
          } catch (error) {
            const refused = refusal(error);
            if (refused === undefined) throw error;
            return status(refused.status, refused.body);
          }
        },
        { authenticated: true, body: bodySchema, params: sectionParamsSchema },
      )

      .get(
        '/config/:section/:entryId',
        ({ params, status }) => {
          const key = keyOf(params.section);
          if (key === undefined) return status(404, NO_SECTION);
          if (!config.hasEntries(key)) return status(409, notEntried(params.section));

          try {
            const value = config.readEntry(key, params.entryId);
            if (value === undefined) return status(404, NO_ENTRY);
            return { entryId: params.entryId, section: key, value };
          } catch (error) {
            const refused = refusal(error);
            if (refused === undefined) throw error;
            return status(refused.status, refused.body);
          }
        },
        { authenticated: true, params: entryParamsSchema },
      )

      /**
       * Creates one entry. A create that quietly replaced an existing agent's
       * prompt and tools because the client reused a name is the mistake this
       * refuses to make; replacing is what `PUT` is for, and it says so.
       */
      .post(
        '/config/:section/:entryId',
        async ({ body, params, status }) => {
          const key = keyOf(params.section);
          if (key === undefined) return status(404, NO_SECTION);
          if (!config.hasEntries(key)) return status(409, notEntried(params.section));

          try {
            if (config.readEntry(key, params.entryId) !== undefined) return status(409, EXISTS);

            const saved = await config.writeEntry(key, params.entryId, body);
            return status(201, {
              entryId: params.entryId,
              restartRequired: saved.restartRequired,
              ...runtime(config),
              section: key,
              value: saved.value,
            });
          } catch (error) {
            const refused = refusal(error);
            if (refused === undefined) throw error;
            return status(refused.status, refused.body);
          }
        },
        { authenticated: true, body: bodySchema, params: entryParamsSchema },
      )

      /**
       * Replaces one entry whole. Not a merge: an entry is read as one document
       * by everything that consumes it, and a patch that dropped `toolSets`
       * while meaning to leave it alone would take an agent's tools away.
       */
      .put(
        '/config/:section/:entryId',
        async ({ body, params, status }) => {
          const key = keyOf(params.section);
          if (key === undefined) return status(404, NO_SECTION);
          if (!config.hasEntries(key)) return status(409, notEntried(params.section));

          try {
            if (config.readEntry(key, params.entryId) === undefined) return status(404, NO_ENTRY);

            const saved = await config.writeEntry(key, params.entryId, body);
            return {
              entryId: params.entryId,
              restartRequired: saved.restartRequired,
              ...runtime(config),
              section: key,
              value: saved.value,
            };
          } catch (error) {
            const refused = refusal(error);
            if (refused === undefined) throw error;
            return status(refused.status, refused.body);
          }
        },
        { authenticated: true, body: bodySchema, params: entryParamsSchema },
      )

      /**
       * Removes one entry, unless removing it is what stops the next start —
       * answered 409 here, where the operator can still read why, rather than at
       * a restart they may not perform until much later.
       */
      .delete(
        '/config/:section/:entryId',
        async ({ params, status }) => {
          const key = keyOf(params.section);
          if (key === undefined) return status(404, NO_SECTION);
          if (!config.hasEntries(key)) return status(409, notEntried(params.section));

          try {
            if (config.readEntry(key, params.entryId) === undefined) return status(404, NO_ENTRY);

            await config.removeEntry(key, params.entryId);
            return {
              entryId: params.entryId,
              restartRequired: config.summary(key).applies === 'restart',
              ...runtime(config),
              section: key,
            };
          } catch (error) {
            const refused = refusal(error);
            if (refused === undefined) throw error;
            return status(refused.status, refused.body);
          }
        },
        { authenticated: true, params: entryParamsSchema },
      )
  );
}

function configRoutes(options: ConfigRoutesOptions): ReturnType<typeof createConfigRoutes> {
  return createConfigRoutes(options);
}

export { configRoutes };

export type { ConfigRoutesOptions };
