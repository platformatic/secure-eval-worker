import { execFileSync } from 'node:child_process'
import { appendFile, readFile, writeFile } from 'node:fs/promises'

const VERSION_EXPRESSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function getUserInfo () {
  const username = process.argv[3] ?? process.env.GITHUB_ACTOR
  const defaultUser = 'mcollina'
  const users = {
    mcollina: ['Matteo Collina', 'hello@matteocollina.com'],
    ShogunPanda: ['Paolo Insogna', 'paolo@cowtech.it']
  }

  return users[username] ?? users[defaultUser]
}

async function getVersion () {
  const requested = process.argv[2]?.replace(/^v/, '')

  if (!requested) {
    throw new Error('Usage: node scripts/bump-version.js <version|major|minor|patch> [actor]')
  }

  if (['major', 'minor', 'patch'].includes(requested)) {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8'))
    const [major, minor, patch] = packageJson.version.split(/[.-]/).slice(0, 3).map(Number)

    switch (requested) {
      case 'major':
        return `${major + 1}.0.0`
      case 'minor':
        return `${major}.${minor + 1}.0`
      default:
        return `${major}.${minor}.${patch + 1}`
    }
  }

  if (!VERSION_EXPRESSION.test(requested)) {
    throw new Error(`Invalid version: ${requested}`)
  }

  return requested
}

async function updateVersions (version) {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'))
  packageJson.version = version
  await writeFile('package.json', `${JSON.stringify(packageJson, null, 2)}\n`)

  const packageLock = JSON.parse(await readFile('package-lock.json', 'utf8'))
  packageLock.version = version
  packageLock.packages[''].version = version
  await writeFile('package-lock.json', `${JSON.stringify(packageLock, null, 2)}\n`)
}

const userInfo = getUserInfo()
const version = await getVersion()

await updateVersions(version)

if (process.env.GITHUB_ACTIONS === 'true') {
  execFileSync('git', ['config', '--global', 'user.name', userInfo[0]])
  execFileSync('git', ['config', '--global', 'user.email', userInfo[1]])
}

if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\n`)
}

execFileSync('git', [
  'commit',
  '-am',
  `chore: Bumped v${version}.`,
  '-m',
  `Signed-off-by: ${userInfo[0]} <${userInfo[1]}>`
], { stdio: 'inherit' })
