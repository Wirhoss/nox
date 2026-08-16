import { valid, validRange } from "semver";
import { z } from "zod";

import { PluginManifestError } from "./errors.ts";

export const NOX_PLUGIN_API_VERSION = 1 as const;

const identifierPattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(214)
  .regex(identifierPattern, "Use a lowercase package-like identifier.");

const semanticVersionSchema = z
  .string()
  .refine((value) => valid(value) !== null, "Expected a valid semantic version.");

const semanticVersionRangeSchema = z
  .string()
  .refine((value) => validRange(value) !== null, "Expected a valid semantic version range.");

const dependencyMapSchema = z.record(identifierSchema, semanticVersionRangeSchema);

export const pluginManifestSchema = z
  .strictObject({
    id: identifierSchema,
    displayName: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(500).optional(),
    version: semanticVersionSchema,
    apiVersion: z.literal(NOX_PLUGIN_API_VERSION),
    engines: z.strictObject({
      nox: semanticVersionRangeSchema,
    }),
    dependencies: dependencyMapSchema.optional(),
    optionalDependencies: dependencyMapSchema.optional(),
  })
  .superRefine((manifest, context) => {
    if (Object.hasOwn(manifest.dependencies ?? {}, manifest.id)) {
      context.addIssue({
        code: "custom",
        message: "A plugin cannot depend on itself.",
        path: ["dependencies", manifest.id],
      });
    }
    if (Object.hasOwn(manifest.optionalDependencies ?? {}, manifest.id)) {
      context.addIssue({
        code: "custom",
        message: "A plugin cannot optionally depend on itself.",
        path: ["optionalDependencies", manifest.id],
      });
    }

    for (const dependencyId of Object.keys(manifest.dependencies ?? {})) {
      if (Object.hasOwn(manifest.optionalDependencies ?? {}, dependencyId)) {
        context.addIssue({
          code: "custom",
          message: `Dependency "${dependencyId}" cannot be both required and optional.`,
          path: ["optionalDependencies", dependencyId],
        });
      }
    }
  });

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

export function parsePluginManifest(input: unknown): PluginManifest {
  const result = pluginManifestSchema.safeParse(input);
  if (!result.success) {
    const pluginId =
      typeof input === "object" && input !== null && "id" in input && typeof input.id === "string"
        ? input.id
        : undefined;
    throw new PluginManifestError(
      `Invalid plugin manifest: ${z.prettifyError(result.error)}`,
      pluginId,
      { cause: result.error },
    );
  }

  return Object.freeze({
    ...result.data,
    engines: Object.freeze({ ...result.data.engines }),
    dependencies: result.data.dependencies
      ? Object.freeze({ ...result.data.dependencies })
      : undefined,
    optionalDependencies: result.data.optionalDependencies
      ? Object.freeze({ ...result.data.optionalDependencies })
      : undefined,
  });
}

export function assertIdentifier(value: string, kind: string): void {
  const result = identifierSchema.safeParse(value);
  if (!result.success) {
    throw new TypeError(`Invalid ${kind} "${value}": ${result.error.issues[0]?.message}`);
  }
}
