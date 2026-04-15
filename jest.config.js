module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testTimeout: 120000,
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  /** By default `npm test` in package.json excludes on-chain integration via --testPathIgnorePatterns; do not globally ignore real-integration here or `npm run test:integration` will not find those tests. */
  moduleFileExtensions: ["ts", "js", "json"],
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.d.ts"],
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: {
          esModuleInterop: true,
        },
      },
    ],
  },
};
