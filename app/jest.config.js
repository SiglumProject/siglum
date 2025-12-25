/**
 * Jest Configuration for Visual LaTeX Editor
 * 
 * Comprehensive test configuration for the visual editor system
 * with proper TypeScript support, mocking, and coverage reporting.
 */

module.exports = {
  // Test environment
  testEnvironment: 'jsdom',
  
  // Setup files
  setupFilesAfterEnv: [
    '<rootDir>/src/components/VisualEditor/__tests__/setup.ts'
  ],
  
  // Module file extensions
  moduleFileExtensions: [
    'js',
    'jsx',
    'ts',
    'tsx',
    'json'
  ],
  
  // Transform files
  transform: {
    '^.+\\.(ts|tsx)$': 'ts-jest',
    '^.+\\.(js|jsx)$': 'babel-jest',
    '^.+\\.css$': 'jest-transform-css',
    '^.+\\.(png|jpg|jpeg|gif|svg)$': 'jest-transform-stub'
  },
  
  // Module name mapping
  moduleNameMapping: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@components/(.*)$': '<rootDir>/src/components/$1',
    '^@services/(.*)$': '<rootDir>/src/services/$1',
    '^@hooks/(.*)$': '<rootDir>/src/hooks/$1',
    '^@utils/(.*)$': '<rootDir>/src/utils/$1',
    '\\.(css|less|scss|sass)$': 'identity-obj-proxy'
  },
  
  // Test patterns
  testMatch: [
    '<rootDir>/src/**/__tests__/**/*.(ts|tsx|js|jsx)',
    '<rootDir>/src/**/?(*.)(test|spec).(ts|tsx|js|jsx)'
  ],
  
  // Ignore patterns
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '/build/',
    '\\.cache'
  ],
  
  // Coverage configuration
  collectCoverage: true,
  coverageDirectory: '<rootDir>/coverage',
  coverageReporters: [
    'text',
    'lcov',
    'html',
    'json-summary'
  ],
  
  // Coverage collection patterns
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/**/__tests__/**',
    '!src/**/*.test.{ts,tsx}',
    '!src/**/*.spec.{ts,tsx}',
    '!src/**/*.stories.{ts,tsx}',
    '!src/main.tsx',
    '!src/vite-env.d.ts'
  ],
  
  // Coverage thresholds
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70
    },
    // Specific thresholds for core modules
    'src/services/LaTeXParser.ts': {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80
    },
    'src/services/EditorSynchronizer.ts': {
      branches: 75,
      functions: 75,
      lines: 75,
      statements: 75
    },
    'src/components/VisualEditor/VisualEditor.tsx': {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70
    },
    'src/components/HybridEditor/HybridEditor.tsx': {
      branches: 65,
      functions: 65,
      lines: 65,
      statements: 65
    }
  },
  
  // Global setup
  globals: {
    'ts-jest': {
      tsconfig: {
        jsx: 'react-jsx'
      }
    }
  },
  
  // Module directories
  moduleDirectories: [
    'node_modules',
    '<rootDir>/src'
  ],
  
  // Clear mocks between tests
  clearMocks: true,
  
  // Restore mocks after each test
  restoreMocks: true,
  
  // Verbose output
  verbose: true,
  
  // Test timeout
  testTimeout: 10000,
  
  // Error on deprecated features
  errorOnDeprecated: true,
  
  // Mock patterns
  transformIgnorePatterns: [
    'node_modules/(?!(monaco-editor|prosemirror-.*|@babel/runtime)/)'
  ],
  
  // Watch plugins for development
  watchPlugins: [
    'jest-watch-typeahead/filename',
    'jest-watch-typeahead/testname'
  ],
  
  // Performance reporting
  maxWorkers: '50%',
  
  // Snapshot serializers
  snapshotSerializers: [
    'enzyme-to-json/serializer'
  ],
  
  // Test results processor
  testResultsProcessor: 'jest-sonar-reporter',
  
  // Custom reporters
  reporters: [
    'default',
    [
      'jest-junit',
      {
        outputDirectory: './coverage',
        outputName: 'junit.xml',
        classNameTemplate: '{classname}',
        titleTemplate: '{title}',
        ancestorSeparator: ' › ',
        usePathForSuiteName: true
      }
    ],
    [
      'jest-html-reporters',
      {
        publicPath: './coverage/html-report',
        filename: 'report.html',
        expand: true
      }
    ]
  ],
  
  // Notification settings (disable in CI)
  notify: process.env.CI !== 'true',
  notifyMode: 'failure-change',
  
  // Error handling
  bail: process.env.CI === 'true' ? 1 : 0,
  
  // Cache
  cache: true,
  cacheDirectory: '<rootDir>/.jest-cache',
  
  // Preset for React Testing Library
  preset: 'ts-jest/presets/js-with-ts',
  
  // Custom test environment options
  testEnvironmentOptions: {
    url: 'http://localhost'
  }
}

// Performance configuration
if (process.env.NODE_ENV === 'test') {
  // Reduce memory usage in test environment
  module.exports.maxWorkers = 2
  module.exports.workerIdleMemoryLimit = '1GB'
}

// CI-specific configuration
if (process.env.CI === 'true') {
  module.exports.maxWorkers = 1
  module.exports.cache = false
  module.exports.verbose = false
  module.exports.collectCoverage = true
  module.exports.coverageReporters = ['lcov', 'text-summary']
}