# Tests

This folder contains the plugin’s automated development tests. Source code lives in `src/`; each `*.test.ts` file checks the corresponding feature, including API responses, workflow progress, suggested actions, and exact response rendering.

These files belong in version control so contributors can verify changes. They are not included in the published plugin package or its runtime bundle.

## Run all tests

From the repository root, using the Node.js version required by `package.json`:

```sh
npm install
npm test
```

## Run one test file

```sh
node --import tsx --test tests/exact-response-hooks.test.ts
```

The tests use Node.js’s built-in test runner and `tsx` to load TypeScript. Keep new test files in this folder and import the code under test from `../src/`.
