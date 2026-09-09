import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const npmExecPath = process.env.npm_execpath
if (!npmExecPath) throw new Error('npm_execpath is required')
const output = execFileSync(process.execPath, [
  npmExecPath,
  'pack',
  '--dry-run',
  '--json'
], { encoding: 'utf8' })
const [pack] = JSON.parse(output)
const actual = pack.files.map(({ path }) => path).sort()
const expected = [
  'LICENSE',
  'README.md',
  'docs/deferred-capabilities.md',
  'docs/error-values.md',
  'docs/module-dependencies.md',
  'docs/one-shot-pooling.md',
  'docs/vercel-labs-run-comparison.md',
  'docs/worker-admission.md',
  'package.json',
  'src/admission.js',
  'src/host-functions.js',
  'src/index.d.ts',
  'src/index.js',
  'src/internal.js',
  'src/local-files.js',
  'src/session.js'
]
assert.deepEqual(actual, expected)
