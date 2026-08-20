import rootConfig from '../../eslint.config.js';

// Public-API guard (mirrors examples/quickstart): the playground must consume
// only the package roots of `@swiftagent/*`. Any deep import into `dist`/`src`
// fails `pnpm lint` in CI. Applied to BOTH source trees of this single package.
export default [
  ...rootConfig,
  {
    files: ['backend/src/**/*.ts', 'frontend/src/**/*.{ts,tsx}'],
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
];
