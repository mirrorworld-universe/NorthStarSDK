module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testTimeout: 120000,
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  /** 默认 `npm test` 在 package.json 里通过 --testPathIgnorePatterns 排除链上集成；勿在此全局忽略 real-integration，否则 test:integration 会找不到用例。 */
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
