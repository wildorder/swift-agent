import rootConfig from '../../../eslint.config.js';

// Public-API guard (SC-05): the example must consume only the package roots of
// `@swiftagent/*`. Any deep import into `dist`/`src` fails `pnpm lint` in CI.
export default [
  ...rootConfig,
  {
    files: ['src/**/*.{ts,tsx}'],
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
                'Import from the package root (e.g. "@swiftagent/react") only — deep imports are not part of the public API.',
            },
          ],
        },
      ],
    },
  },
];
