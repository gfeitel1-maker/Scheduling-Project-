import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // 'release' is the electron-builder output: a full copy of the project,
  // including a minified bundle. Linting it produced 325 errors that describe
  // build artifacts, not source. Same defect class as the vitest collection
  // bug fixed alongside this — packaging copies everything, and every tool
  // that walks the tree has to know that.
  globalIgnores(['dist', 'release']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]', argsIgnorePattern: '^_' }],
    },
  },
  {
    // Electron main-process files and all test files run under Node, not the
    // browser — so Node globals (Buffer, process, require, setImmediate, …)
    // are legitimately defined. Merge them on top of the browser globals.
    files: ['electron/**/*.js', '**/*.test.{js,jsx}'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['src/**/*.{js,jsx}', 'electron/**/*.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@supabase/*'],
              message:
                'The Supabase backend is retired (see legacy/supabase/README.md). Do not import @supabase packages from active code under src/ or electron/.',
            },
          ],
        },
      ],
    },
  },
])
