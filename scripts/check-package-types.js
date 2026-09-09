import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npmExecPath = process.env.npm_execpath
if (!npmExecPath) throw new Error('npm_execpath is required')
const temporary = mkdtempSync(join(tmpdir(), 'secure-eval-worker-types-'))

try {
  const output = execFileSync(process.execPath, [
    npmExecPath,
    'pack',
    '--json',
    '--pack-destination',
    temporary
  ], { cwd: root, encoding: 'utf8' })
  const [{ filename }] = JSON.parse(output)
  const project = join(temporary, 'project')
  const installedPackage = join(project, 'node_modules', 'secure-eval-worker')
  mkdirSync(installedPackage, { recursive: true })
  execFileSync('tar', ['-xzf', join(temporary, filename), '--strip-components=1', '-C', installedPackage])
  symlinkSync(
    join(root, 'node_modules', '@types'),
    join(project, 'node_modules', '@types'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  cpSync(join(root, 'fixtures', 'types'), project, { recursive: true })

  execFileSync(process.execPath, [
    '--input-type=commonjs',
    '--eval',
    "const api = require('secure-eval-worker'); if (typeof api.runUntrustedFile !== 'function' || typeof api.createUntrustedWorkerFromFile !== 'function') process.exit(1)"
  ], { cwd: project, stdio: 'inherit' })

  execFileSync(process.execPath, [
    join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--project',
    project
  ], { cwd: project, stdio: 'inherit' })

  const packed = JSON.parse(readFileSync(join(installedPackage, 'package.json'), 'utf8'))
  if (packed.exports?.['.']?.types !== './src/index.d.ts' || packed.types !== './src/index.d.ts') {
    throw new Error('Packed declaration metadata is invalid')
  }
} finally {
  rmSync(temporary, { force: true, recursive: true })
}
