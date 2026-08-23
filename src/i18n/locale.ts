import { z } from 'zod';

/** Lowercase BCP 47 form used in configuration, URLs and contribution IDs. */
const localeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/u, 'Expected a lowercase BCP 47 language tag.');

export { localeSchema };
