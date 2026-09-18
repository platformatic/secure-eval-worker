import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const npmExecPath = process.env.npm_execpath
if (!npmExecPath) throw new Error('npm_execpath is required')
const temporary = mkdtempSync(join(tmpdir(), 'secure-eval-worker-package-'))
try {
  const output = execFileSync(process.execPath, [
    npmExecPath,
    'pack',
    '--json',
    '--pack-destination',
    temporary
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
    'src/session-bootstrap.js',
    'src/session.js'
  ]
  assert.deepEqual(actual, expected)

  const application = join(temporary, 'application')
  const fixture = join(temporary, 'fixture')
  mkdirSync(application)
  mkdirSync(fixture)
  writeFileSync(join(application, 'package.json'), '{"type":"module"}')
  writeFileSync(join(fixture, 'entry.mjs'), 'export default input => input + 1\n')
  const archive = join(temporary, pack.filename)
  execFileSync(process.execPath, [
    npmExecPath,
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    archive
  ], { cwd: application, stdio: 'pipe' })
  const smoke = `
    import { runUntrustedCode, runUntrustedFile } from 'secure-eval-worker'
    const source = await runUntrustedCode('return input + 1', {
      input: 41,
      timeoutMs: 5000
    })
    const local = await runUntrustedFile(${JSON.stringify(join(fixture, 'entry.mjs'))}, {
      rootDirectory: ${JSON.stringify(fixture)},
      input: 41,
      timeoutMs: 5000
    })
    console.log(JSON.stringify({ source, local }))
  `
  const smokeOutput = execFileSync(process.execPath, [
    '--input-type=module',
    '--eval',
    smoke
  ], { cwd: application, encoding: 'utf8' })
  assert.deepEqual(JSON.parse(smokeOutput), { source: 42, local: 42 })
} finally {
  rmSync(temporary, { force: true, recursive: true })
}
