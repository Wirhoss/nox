import js from '@eslint/js';
import perfectionist from 'eslint-plugin-perfectionist';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const sourceFiles = ['**/src/**/*.{js,mjs,cjs,ts,mts,cts}'];

export default defineConfig([
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.astro/**'] },
  { files: sourceFiles, plugins: { js }, extends: ['js/recommended'], languageOptions: { globals: globals.browser } },
  { files: sourceFiles, extends: [tseslint.configs.recommended] },
  {
    files: sourceFiles,
    plugins: {
      perfectionist,
    },
  },
  {
    files: sourceFiles,
    rules: {
      quotes: ['error', 'single'],
      semi: ['error', 'always'],
      '@typescript-eslint/no-unused-vars': ['error', {
        vars: 'all',
        args: 'all',
        argsIgnorePattern: '^_',
        caughtErrors: 'all',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/no-unused-expressions': 'error',
      'no-unreachable': 'error',
      'perfectionist/sort-imports': ['error', {
        'order': 'asc',
        'type': 'natural',
        'groups': [
          'builtin',
          'external',
          'internal',
          'parent',
          'sibling',
          'index',
          'type',
          'side-effect',
        ],
        'newlinesBetween': 1,
      }],
    },
  },
]);
