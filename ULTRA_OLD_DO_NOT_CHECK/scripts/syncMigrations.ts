import { cpSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dir, '..');
const source = resolve(repositoryRoot, 'src/database/migrations');
const target = resolve(repositoryRoot, 'dist/migrations');

// `dist` is generated output. Replacing this exact subtree prevents an older
// build from leaving nested or removed migrations in the production bundle.
rmSync(target, { force: true, recursive: true });
cpSync(source, target, { recursive: true });
