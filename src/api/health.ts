import { Elysia } from 'elysia';

/** What a single readiness check answers: reachable, or not and why. */
type ReadinessCheck = () => Promise<boolean> | boolean;

/** The dependencies readiness is the conjunction of, named for the response. */
type ReadinessChecks = Readonly<Record<string, ReadinessCheck>>;

interface HealthOptions {
  checks?: ReadinessChecks;
  startedAt?: number;
  version?: string;
}

type CheckStatus = 'fail' | 'pass';

interface ReadinessReport {
  checks: Record<string, CheckStatus>;
  status: CheckStatus;
}

/**
 * Runs every check, including the ones after a failure: an operator reading a
 * 503 wants the whole picture, not the first thing that happened to break. A
 * check that throws is a failed check — an exception is how a dependency that
 * is down usually reports itself.
 */
async function report(checks: ReadinessChecks): Promise<ReadinessReport> {
  const entries = await Promise.all(
    Object.entries(checks).map(async ([name, check]): Promise<[string, CheckStatus]> => {
      try {
        return [name, (await check()) ? 'pass' : 'fail'];
      } catch {
        return [name, 'fail'];
      }
    }),
  );

  return {
    checks: Object.fromEntries(entries),
    status: entries.every(([, status]) => status === 'pass') ? 'pass' : 'fail',
  };
}

/**
 * The two questions an orchestrator asks, kept apart because they have
 * different consequences: a failed liveness probe restarts the container, a
 * failed readiness probe only takes it out of rotation.
 *
 * Liveness is deliberately empty of dependencies. A database that went away is
 * not a reason to kill a process that is otherwise answering — restarting it
 * will not bring the database back.
 */
function health(options: HealthOptions = {}) {
  const { checks = {}, startedAt = Date.now(), version } = options;

  return new Elysia({ name: 'nox.api.health' })
    .get('/health/live', () => ({
      status: 'pass',
      uptimeMs: Date.now() - startedAt,
      version,
    }))
    .get('/health/ready', async ({ set }) => {
      const result = await report(checks);
      set.status = result.status === 'pass' ? 200 : 503;
      return { ...result, version };
    });
}

export { health };

export type { HealthOptions, ReadinessCheck, ReadinessChecks, ReadinessReport };
