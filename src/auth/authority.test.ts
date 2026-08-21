import { describe, expect, test } from 'bun:test';

import {
  AuthorityCatalog,
  type AuthorityDefinition,
  CORE_OWNER_ID,
  matchesPattern,
  ownerNamespace,
} from './authority';
import { CORE_AUTHORITIES } from './coreAuthorities';

function definition(id: string, ownerExtensionId = CORE_OWNER_ID): AuthorityDefinition {
  return { description: `The ${id} authority.`, id, ownerExtensionId };
}

describe('AuthorityCatalog', () => {
  test('accepts the core catalog and reports it sorted', () => {
    const catalog = AuthorityCatalog.from(CORE_AUTHORITIES);

    expect(catalog.ids).toEqual([
      'nox.history.read',
      'nox.history.search',
      'nox.tools.call',
      'nox.tools.search',
    ]);
    expect(catalog.has('nox.history.read')).toBeTrue();
    expect(catalog.has('nox.history.write')).toBeFalse();
  });

  test('refuses an authority outside its owner namespace', () => {
    expect(() => AuthorityCatalog.from([definition('other.thing', 'nox.toolset.web')])).toThrow(
      'may only register authorities under "nox.toolset.web."',
    );
    // A scoped extension ID becomes a dotted namespace, and owns only that.
    expect(() =>
      AuthorityCatalog.from([definition('acme.tools.read', '@acme/tools')]),
    ).not.toThrow();
    expect(() => AuthorityCatalog.from([definition('nox.history.read', '@acme/tools')])).toThrow(
      'cannot own authority',
    );
  });

  test('refuses a duplicated name, and malformed names', () => {
    // Two *different* owners cannot collide at all — the namespace rule catches
    // that first — so the duplicate this guards against is one owner
    // registering the same name twice.
    expect(() => AuthorityCatalog.from([definition('nox.a.b'), definition('nox.a.b')])).toThrow(
      'is registered by both',
    );
    expect(() => AuthorityCatalog.from([definition('Nox.Shouty')])).toThrow('Invalid authority');
    // A single segment names a namespace, not an authority inside one.
    expect(() => AuthorityCatalog.from([definition('nox')])).toThrow('Invalid authority');
  });

  test('normalizes owner IDs into namespaces', () => {
    expect(ownerNamespace('@acme/tools')).toBe('acme.tools');
    expect(ownerNamespace('nox.toolset.web')).toBe('nox.toolset.web');
  });
});

describe('grant patterns', () => {
  const catalog = AuthorityCatalog.from([
    ...CORE_AUTHORITIES,
    definition('nox.files.read'),
    definition('nox.files.write'),
  ]);

  test('a wildcard covers an authority added after the grant was written', () => {
    // The grant is fixed; the catalog is not. Whoever wrote `*` accepted this.
    expect(catalog.covers(['*'], 'nox.files.read')).toBe('*');
    expect(matchesPattern('*', 'some.authority.invented.later')).toBeTrue();
  });

  test('a namespace wildcard covers future authorities of that namespace only', () => {
    expect(matchesPattern('nox.files.*', 'nox.files.delete')).toBeTrue();
    expect(matchesPattern('nox.files.*', 'nox.history.read')).toBeFalse();
    // It matches on a segment boundary, never mid-segment.
    expect(matchesPattern('nox.file.*', 'nox.files.read')).toBeFalse();
  });

  test('an explicit grant stays closed', () => {
    expect(catalog.covers(['nox.files.read'], 'nox.files.read')).toBe('nox.files.read');
    expect(catalog.covers(['nox.files.read'], 'nox.files.write')).toBeUndefined();
    expect(catalog.covers(['nox.files.read'], 'nox.files.delete')).toBeUndefined();
  });

  test('validates entries against canonical names without freezing what they cover', () => {
    expect(() => {
      catalog.assertGrantPattern('*', 'A principal');
    }).not.toThrow();
    expect(() => {
      catalog.assertGrantPattern('nox.files.*', 'A principal');
    }).not.toThrow();
    expect(() => {
      catalog.assertGrantPattern('nox.files.read', 'A principal');
    }).not.toThrow();

    // A typo in a namespace is a typo, not a grant that quietly matches nothing.
    expect(() => {
      catalog.assertGrantPattern('nox.fils.*', 'A principal');
    }).toThrow('no registered authority lives under "nox.fils."');
    expect(() => {
      catalog.assertGrantPattern('nox.files.delete', 'A principal');
    }).toThrow('which nothing registered');
  });
});
