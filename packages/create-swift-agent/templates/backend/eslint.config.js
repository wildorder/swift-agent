import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

// Public-API guard: consume only the package roots of `@swiftagent/*`. Deep
// imports into `dist`/`src` are not part of the public API and fail lint.
export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@swiftagent/*/dist',
                '@swiftagent/*/dist/*',
                '@swiftagent/*/src',
                '@swiftagent/*/src/*',
              ],
              message:
                'Import from the package root (e.g. "@swiftagent/sdk") only — deep imports are not part of the public API.',
            },
          ],
        },
      ],
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
);
