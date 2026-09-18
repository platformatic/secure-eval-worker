import neostandard, { resolveIgnoresFromGitignore } from 'neostandard'

export default [
  ...neostandard({
    ignores: [
      ...resolveIgnoresFromGitignore(),
      // Generated and byte-sensitive runtime sources are validated separately.
      'src/node-capability-surfaces.js',
      'src/session-bootstrap.js'
    ]
  }),
  {
    rules: {
      'no-unmodified-loop-condition': 'off',
      'no-void': 'off'
    }
  },
  {
    files: ['scripts/check-node-capabilities.js'],
    rules: {
      camelcase: 'off'
    }
  },
  {
    files: ['test/**/*.js'],
    rules: {
      'accessor-pairs': 'off',
      'no-control-regex': 'off',
      'no-extend-native': 'off'
    }
  }
]
