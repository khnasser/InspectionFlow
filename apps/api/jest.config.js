/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.spec.ts'],
  moduleNameMapper: { '^@inspectionflow/engine$': '<rootDir>/../../packages/engine/src' },
  globalSetup: '<rootDir>/test/global-setup.ts',
  globalTeardown: '<rootDir>/test/global-teardown.ts',
  testTimeout: 30000,
  // In CI, failures also appear as annotations on the run (readable through the GitHub API).
  reporters: process.env.GITHUB_ACTIONS ? ['default', ['github-actions', { silent: false }], 'summary'] : ['default'],
};
