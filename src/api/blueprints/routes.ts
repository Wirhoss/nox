import { Elysia } from 'elysia';
import { z } from 'zod';

import { isConfigError } from '../../config/error';
import { authGuard } from '../auth/guard';
import { BlueprintReferenceError, type BlueprintStore } from './store';

import type { Blueprint } from '../../config/blueprint';
import type { AuthStore } from '../auth/store';

/** No blueprint is filed under that name. */
const NO_BLUEPRINT = { error: 'blueprint_not_found' } as const;

/** One already is, and a create is not a replace. */
const EXISTS = { error: 'blueprint_exists' } as const;

/**
 * The agent's ID is the name of its file, so it is the file-name alphabet the
 * loader enforces rather than a second one: a stricter dialect here would leave
 * blueprints on disk that this surface can list and not address.
 */
const agentIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
    'Use up to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit.',
  );

const agentParamsSchema = z.object({ agentId: agentIdSchema });

/**
 * A blueprint arrives as whatever JSON object the client sent and is judged by
 * the section's own schema, not by a copy of it written here. That is the point:
 * a blueprint posted to this route and a blueprint typed into the file by hand
 * go through one definition of valid, so neither can be accepted on terms the
 * other refuses — including the rejection of keys no setting matches, which a
 * second schema in this file would silently strip instead.
 */
const bodySchema = z.record(z.string(), z.unknown());

interface BlueprintRoutesOptions {
  readonly blueprints: BlueprintStore;
  readonly store: AuthStore;
}

interface Refusal {
  detail: string;
  error: string;
  problems?: readonly string[];
}

/**
 * Turns the configuration's own refusals into an answer, and lets everything
 * else through. A disk that cannot be written is not a bad request, and
 * reporting it as one would send the operator looking at their JSON.
 */
function refusal(error: unknown): Refusal | undefined {
  if (error instanceof BlueprintReferenceError) {
    return { detail: error.message, error: 'unknown_reference', problems: error.problems };
  }
  if (isConfigError(error) && (error.code === 'invalid_schema' || error.code === 'unknown_keys')) {
    return { detail: error.message, error: 'invalid_blueprint' };
  }
  return undefined;
}

function entry(agentId: string, blueprint: Blueprint): { agentId: string; blueprint: Blueprint } {
  return { agentId, blueprint };
}

/**
 * The blueprints as an administrable set: one file per agent, addressed by the
 * agent's ID.
 *
 * Every write says `restartRequired`, and always true, because it is: agents are
 * registered once while Nox composes itself, so a blueprint saved here describes
 * the agent the next start will have rather than the one running now. Saying so
 * on every write, instead of leaving the client to know it, is what keeps a
 * surface from showing an edit as though it had taken effect.
 *
 * Authenticated throughout. A blueprint carries the system prompt, the model and
 * the tool grants of an agent — it is the whole of what a Nox will do, and the
 * one thing on this surface most worth changing quietly.
 */
function createBlueprintRoutes(options: BlueprintRoutesOptions) {
  const { blueprints, store } = options;

  return (
    new Elysia({ name: 'nox.api.blueprints.routes' })
      .use(authGuard(store))

      /** Every configured agent, by ID. Sorted, so a redraw never reorders a list. */
      .get(
        '/blueprints',
        () => ({
          blueprints: Object.entries(blueprints.list())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([agentId, blueprint]) => entry(agentId, blueprint)),
          defaultAgent: blueprints.defaultAgent,
        }),
        { authenticated: true },
      )

      .get(
        '/blueprints/:agentId',
        ({ params, status }) => {
          const blueprint = blueprints.read(params.agentId);
          if (blueprint === undefined) return status(404, NO_BLUEPRINT);
          return entry(params.agentId, blueprint);
        },
        { authenticated: true, params: agentParamsSchema },
      )

      /**
       * Creates one. A create that quietly replaced an existing agent's prompt
       * and tools because the client reused a name is the mistake this refuses
       * to make; replacing is what `PUT` is for, and it says so.
       */
      .post(
        '/blueprints/:agentId',
        async ({ body, params, status }) => {
          if (blueprints.read(params.agentId) !== undefined) return status(409, EXISTS);

          try {
            const saved = await blueprints.save(params.agentId, body);
            return status(201, { ...entry(params.agentId, saved.value), restartRequired: true });
          } catch (error) {
            const refused = refusal(error);
            if (refused === undefined) throw error;
            return status(422, refused);
          }
        },
        { authenticated: true, body: bodySchema, params: agentParamsSchema },
      )

      /**
       * Replaces one whole. Not a merge: a blueprint is read as one document by
       * everything that consumes it, and a patch that dropped `toolSets` while
       * meaning to leave it alone would take an agent's tools away.
       */
      .put(
        '/blueprints/:agentId',
        async ({ body, params, status }) => {
          if (blueprints.read(params.agentId) === undefined) return status(404, NO_BLUEPRINT);

          try {
            const saved = await blueprints.save(params.agentId, body);
            return { ...entry(params.agentId, saved.value), restartRequired: true };
          } catch (error) {
            const refused = refusal(error);
            if (refused === undefined) throw error;
            return status(422, refused);
          }
        },
        { authenticated: true, body: bodySchema, params: agentParamsSchema },
      )

      /**
       * Removes one, unless removing it is what stops the next start. Bootstrap
       * refuses to compose a Nox with no agent at all, and refuses one whose
       * configured default agent no blueprint defines — so both answer 409 here,
       * where the operator can still read why, rather than at a restart they may
       * not perform until much later.
       */
      .delete(
        '/blueprints/:agentId',
        async ({ params, status }) => {
          const { agentId } = params;
          if (blueprints.read(agentId) === undefined) return status(404, NO_BLUEPRINT);

          if (Object.keys(blueprints.list()).length === 1) {
            return status(409, {
              detail: 'Nox composes no agent from an empty blueprints directory.',
              error: 'last_blueprint',
            });
          }
          if (blueprints.defaultAgent === agentId) {
            return status(409, {
              detail: `Web chat names "${agentId}" as its default agent; change app.json first.`,
              error: 'default_agent',
            });
          }

          await blueprints.remove(agentId);
          return { agentId, restartRequired: true };
        },
        { authenticated: true, params: agentParamsSchema },
      )
  );
}

function blueprintRoutes(
  options: BlueprintRoutesOptions,
): ReturnType<typeof createBlueprintRoutes> {
  return createBlueprintRoutes(options);
}

export { blueprintRoutes };

export type { BlueprintRoutesOptions };
