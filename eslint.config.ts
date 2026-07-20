import js from '@eslint/js';
import perfectionist from 'eslint-plugin-perfectionist';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  { files: ['**/*.{js,mjs,cjs,ts,mts,cts}'], plugins: { js }, extends: ['js/recommended'], languageOptions: { globals: globals.browser } },
  tseslint.configs.recommended,
  {
    plugins: {
      perfectionist,
    },
  },
  {
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
