import { Elysia } from 'elysia';
import { z } from 'zod';

import {
  type SecretConsumer,
  secretIdSchema,
  type SecretStore,
  type SecretSummary,
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
 * What a secret looks like from outside: where configuration names it, whether a
 * value has been written for it, when that happened, and who has asked for it
 * since this process started. Never the value — not on create, not on read, not
 * on delete. A route that could return one is a route that eventually does.
 *
 * `references` and `consumers` are close but not the same, and the difference is
 * the point. A reference is a fact about the configuration as it stands, known
 * whether or not anything has been composed from it. A consumer is something
 * holding a snapshot of the value right now, which is the only thing that can
 * make a replacement wait for a restart.
 *
 * A row with references and `stored: false` is the case this surface exists to
 * make visible: configuration names a credential nobody has supplied yet.
 *
 * `restartRequired` is the honest answer rather than a cautious one. Resolved
 * secrets are snapshots: whoever already holds a handle keeps the old value
 * until it is composed again, so replacing a secret nothing has resolved takes
 * effect immediately, and replacing one a provider is using does not.
 */
function describe(
  summary: SecretSummary,
  consumers: readonly SecretConsumer[],
): Record<string, unknown> {
  return {
    consumers: [...consumers].sort((a, b) => a.location.localeCompare(b.location)),
    references: [...summary.references],
    restartRequired: consumers.length > 0,
    secretId: summary.secretId,
    stored: summary.stored,
    ...(summary.createdAt === undefined ? {} : { createdAt: summary.createdAt }),
    ...(summary.updatedAt === undefined ? {} : { updatedAt: summary.updatedAt }),
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

      /**
       * Every known secret, by ID: the ones holding a value and the ones
       * configuration names without one. Both belong here — an operator asking
       * what credentials this Nox has is asking the same question as one asking
       * what it is still missing, and answering only the first is what makes a
       * needed credential invisible until something fails over it.
       *
       * Sorted, so a redraw never reorders a list.
       */
      .get(
        '/secrets',
        async () => ({
          secrets: (await secrets.list()).map((summary) =>
            describe(summary, secrets.consumers(summary.secretId)),
          ),
        }),
        { authenticated: true },
      )

      /** One of them. Referenced but unwritten is a secret, not a 404. */
      .get(
        '/secrets/:secretId',
        async ({ params, status }) => {
          const summary = (await secrets.list()).find(
            (candidate) => candidate.secretId === params.secretId,
          );
          if (summary === undefined) return status(404, NO_SECRET);

          return describe(summary, secrets.consumers(params.secretId));
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
          const described = describe(
            { ...metadata, references: secrets.references(params.secretId), stored: true },
            secrets.consumers(params.secretId),
          );

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
          // Read before the delete: what still names this ID is unchanged by the
          // value going away, and it is what says whether the ID stays listed.
          const references = secrets.references(params.secretId);
          if (!(await secrets.delete(params.secretId))) return status(404, NO_SECRET);

          return {
            consumers: [...consumers].sort((a, b) => a.location.localeCompare(b.location)),
            references: [...references],
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
