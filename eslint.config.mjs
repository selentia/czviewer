import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import prettierPlugin from 'eslint-plugin-prettier';
import globals from 'globals';

export default [
  { ignores: ['dist/**', 'node_modules/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,

  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: process.cwd()
      },
      globals: {
        ...globals.node,
        ...globals.es2021
      }
    },
    plugins: { prettier: prettierPlugin },
    rules: {
      eqeqeq: 'warn',
      'prefer-const': 'warn',
      'no-duplicate-imports': 'warn',

      'no-console': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',

      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-var-requires': 'off',
      '@typescript-eslint/no-require-imports': 'off',

      '@typescript-eslint/no-floating-promises': 'warn',

      'prettier/prettier': ['error', { endOfLine: 'auto' }]
    }
  }
];
