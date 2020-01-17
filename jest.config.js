module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testPathIgnorePatterns: ['<rootDir>/dist'],
  collectCoverage: true,
  coveragePathIgnorePatterns: ['^.+\\.lua$'],
  transform: {
    '^.+\\.lua$': 'jest-text-transformer'
  }
}
