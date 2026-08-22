import { Elysia } from 'elysia';
import { z } from 'zod';

import {
  type SecretConsumer,
  secretIdSchema,
  type SecretMetadata,
  type SecretStore,
} from '../../config/secrets';
import { authGuard } from '../auth/guard';

import type { AuthStore } from '../auth/store';

/** No secret is filed under that ID. */
const NO_SECRET = { error: 'secret_not_found' } as const;

const secretParamsSchema = z.object({ secretId: secretIdSchema });

/**
 * A secret is written as its value and nothing else. There is no name, no
 * description and no metadata to send: everything else about a secret is either
 * its ID or something this surface observed, and a field the client could set
 * would be a field the client could disagree with the store about.
 */
const bodySchema = z.object({
  value: z.string().min(1, 'A secret cannot be empty.'),
});

interface SecretRoutesOptions {
  readonly secrets: SecretStore;
  readonly store: AuthStore;
}

/**
 * What a secret looks like from outside: when it was written, and who asked for
 * it since this process started. Never the value — not on create, not on read,
 * not on delete. A route that could return one is a route that eventually does.
 *
 * `restartRequired` is the honest answer rather than a cautious one. Resolved
 * secrets are snapshots: whoever already holds a handle keeps the old value
 * until it is composed again, so replacing a secret nothing has resolved takes
 * effect immediately, and replacing one a provider is using does not.
 */
function describe(
  metadata: SecretMetadata,
  consumers: readonly SecretConsumer[],
): Record<string, unknown> {
  return {
    consumers: [...consumers].sort((a, b) => a.location.localeCompare(b.location)),
    createdAt: metadata.createdAt,
    restartRequired: consumers.length > 0,
    secretId: metadata.secretId,
    updatedAt: metadata.updatedAt,
  };
}

/**
 * The managed secrets as an administrable set. Values go in and never come out:
 * ordinary configuration names a secret with `{"$secret":"..."}` and the store
 * hands the value only to the code composing a contribution, so this surface
 * exists to write and to account for them, not to read them back.
 *
 * Consumers are reported everywhere they are known because they are the whole of
 * what an operator needs to judge a change: a secret nothing has resolved can be
 * rewritten freely, and one three providers hold is a restart. They are what
 * this process has resolved since it started, not a promise about the next one.
 *
 * Authenticated throughout, which barely needs saying: these are the credentials
 * every outbound call Nox makes is authorized with.
 */
function createSecretRoutes(options: SecretRoutesOptions) {
  const { secrets, store } = options;

  return (
    new Elysia({ name: 'nox.api.secrets.routes' })
      .use(authGuard(store))

      /** Every managed secret, by ID. Sorted, so a redraw never reorders a list. */
      .get(
        '/secrets',
        async () => ({
          secrets: (await secrets.list()).map((metadata) =>
            describe(metadata, secrets.consumers(metadata.secretId)),
          ),
        }),
        { authenticated: true },
      )

      .get(
        '/secrets/:secretId',
        async ({ params, status }) => {
          const metadata = (await secrets.list()).find(
            (candidate) => candidate.secretId === params.secretId,
          );
          if (metadata === undefined) return status(404, NO_SECRET);

          return describe(metadata, secrets.consumers(params.secretId));
        },
        { authenticated: true, params: secretParamsSchema },
      )

      /**
       * Creates or replaces one. `PUT` rather than a `POST`/`PUT` pair because
       * the two are genuinely the same act here: there is no existing value to
       * be shown, compared or merged with, so refusing a create because the ID
       * is taken would only tell the client something it cannot use.
       *
       * The status still distinguishes them — 201 when the ID is new — because
       * that is a fact about what happened rather than a decision the client has
       * to make beforehand.
       */
      .put(
        '/secrets/:secretId',
        async ({ body, params, status }) => {
          const created = !(await secrets.has(params.secretId));
          const metadata = await secrets.set(params.secretId, body.value);
          const described = describe(metadata, secrets.consumers(params.secretId));

          return created ? status(201, described) : described;
        },
        { authenticated: true, body: bodySchema, params: secretParamsSchema },
      )

      /**
       * Removes one. Consumers do not block it, and that is deliberate: they are
       * this run's resolutions, so a secret whose configuration was already
       * removed would still list them and could never be deleted without a
       * restart first. They are reported instead, which is what lets a surface
       * warn about exactly the case that matters — deleting something still in
       * use — without making the honest case impossible.
       */
      .delete(
        '/secrets/:secretId',
        async ({ params, status }) => {
          const consumers = secrets.consumers(params.secretId);
          if (!(await secrets.delete(params.secretId))) return status(404, NO_SECRET);

          return {
            consumers: [...consumers].sort((a, b) => a.location.localeCompare(b.location)),
            restartRequired: consumers.length > 0,
            secretId: params.secretId,
          };
        },
        { authenticated: true, params: secretParamsSchema },
      )
  );
}

function secretRoutes(options: SecretRoutesOptions): ReturnType<typeof createSecretRoutes> {
  return createSecretRoutes(options);
}

export { secretRoutes };

export type { SecretRoutesOptions };
