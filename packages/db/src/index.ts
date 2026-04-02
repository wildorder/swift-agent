import { PACKAGE_NAME as SHARED_PACKAGE } from '@swiftagent/shared';

export const PACKAGE_NAME = 'db' as const;

/** Smoke-test: proves cross-package import resolves */
export const DEPENDS_ON = SHARED_PACKAGE;
