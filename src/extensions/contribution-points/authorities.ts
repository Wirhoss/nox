import { createContributionPoint } from '../contribution';

/**
 * An authority an extension declares so its tools can reference it and grants can
 * name it. The contribution ID *is* the authority ID, and the registry already
 * records which extension registered it — so ownership is a property of how it
 * was contributed rather than a field an extension fills in about itself.
 *
 * The namespace rule is enforced when the catalog is assembled: an extension may
 * only own authorities under its own ID, which is what keeps `nox.*` with the
 * core and its builtins and stops two extensions claiming one name.
 */
interface AuthorityContribution {
  readonly description: string;
}

const authorities = createContributionPoint<AuthorityContribution>('nox.authorities');

export { authorities };

export type { AuthorityContribution };
