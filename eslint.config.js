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
  // '.claude/worktrees' is the same defect class again, from a different
  // direction: an agent worktree is a full checkout of the project living
  // inside the project, so linting it reports another branch's in-progress
  // code as errors on this one. Observed 2026-07-28 — 16 errors, none of
  // them in the working tree.
  globalIgnores(['dist', 'release', '.claude/worktrees']),
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
    // Electron main-process files, build/install scripts, and all test files
    // run under Node, not the browser — so Node globals (Buffer, process,
    // require, setImmediate, …) are legitimately defined. Merge them on top of
    // the browser globals.
    files: ['electron/**/*.js', 'scripts/**/*.js', '**/*.test.{js,jsx}'],
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
