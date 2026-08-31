import pluginVitest from '@vitest/eslint-plugin'
import { defineConfigWithVueTs, vueTsConfigs } from '@vue/eslint-config-typescript'
import skipFormatting from 'eslint-config-prettier/flat'
import pluginOxlint from 'eslint-plugin-oxlint'
import perfectionist from 'eslint-plugin-perfectionist'
import pluginVue from 'eslint-plugin-vue'
import { globalIgnores } from 'eslint/config'


export default defineConfigWithVueTs(
  {
    name: 'app/files-to-lint',
    files: ['**/*.{vue,ts,mts,tsx}'],
  },

  globalIgnores(['**/dist/**', '**/dist-ssr/**', '**/coverage/**']),

  ...pluginVue.configs['flat/essential'],
  vueTsConfigs.strictTypeChecked,
  vueTsConfigs.stylisticTypeChecked,

  {
    ...pluginVitest.configs.recommended,
    files: ['**/*.vitest.{ts,mts,tsx}'],
  },

  {
    name: 'nox-ui/typescript',
    files: ['**/*.{vue,ts,mts,tsx}'],
    plugins: {
      perfectionist,
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
      reportUnusedInlineConfigs: 'error',
    },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',
      'no-duplicate-imports': ['error', { allowSeparateTypeImports: true }],
      'no-implicit-coercion': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'ImportDeclaration:has(ImportSpecifier[importKind=type]):has(:matches(ImportSpecifier[importKind=value], ImportDefaultSpecifier, ImportNamespaceSpecifier))',
          message: 'Do not mix type and value imports in the same import declaration.',
        },
      ],
      'no-template-curly-in-string': 'error',
      'no-unneeded-ternary': 'error',
      'object-shorthand': ['error', 'always'],
      'prefer-object-has-own': 'error',

      '@typescript-eslint/consistent-type-exports': [
        'error',
        { fixMixedExportsWithInlineTypeSpecifier: true },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          disallowTypeAnnotations: false,
          fixStyle: 'separate-type-imports',
          prefer: 'type-imports',
        },
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-explicit-any': [
        'error',
        { fixToUnknown: true, ignoreRestArgs: false },
      ],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-shadow': 'error',
      '@typescript-eslint/no-use-before-define': [
        'error',
        { classes: true, enums: true, functions: false, typedefs: false, variables: true },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
          vars: 'all',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/strict-boolean-expressions': [
        'error',
        {
          allowAny: false,
          allowNullableBoolean: false,
          allowNullableEnum: false,
          allowNullableNumber: false,
          allowNullableObject: true,
          allowNullableString: false,
          allowNumber: false,
          allowString: false,
        },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        {
          allowDefaultCaseForExhaustiveSwitch: false,
          considerDefaultExhaustiveForUnions: false,
          requireDefaultForNonUnion: true,
        },
      ],
      '@typescript-eslint/unified-signatures': 'error',

      'perfectionist/sort-imports': [
        'error',
        {
          groups: [
            'builtin',
            'external',
            'internal',
            ['parent', 'sibling', 'index'],
            'type',
            'side-effect',
            'side-effect-style',
            'style',
            'unknown',
          ],
          newlinesBetween: 1,
          order: 'asc',
          type: 'natural',
        },
      ],
      'perfectionist/sort-named-exports': ['error', { order: 'asc', type: 'natural' }],
      'perfectionist/sort-named-imports': ['error', { order: 'asc', type: 'natural' }],
      'perfectionist/sort-union-types': ['error', { order: 'asc', type: 'natural' }],
    },
  },

  ...pluginOxlint.buildFromOxlintConfigFile('.oxlintrc.json'),

  skipFormatting,

  {
    name: 'nox-ui/single-quotes',
    files: ['**/*.{vue,js,mjs,cjs,ts,tsx,mts,cts}'],
    rules: {
      quotes: ['error', 'single', { allowTemplateLiterals: false, avoidEscape: true }],
    },
  },
)
