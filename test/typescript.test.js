import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createUntrustedWorker, runUntrustedCode } from '../src/index.js'

const SESSION_OPTIONS = {
  startupTimeoutMs: 5_000,
  messageTimeoutMs: 5_000,
  lifetimeTimeoutMs: 5_000,
  language: 'typescript'
}

test('one-shot source optionally strips erasable TypeScript syntax', async () => {
  const value = await runUntrustedCode(`
    interface Input { value: number }
    const typed = input as Input
    return typed.value satisfies number
  `, {
    input: { value: 42 },
    language: 'typescript',
    timeoutMs: 5_000
  })
  assert.equal(value, 42)
})

for (const type of ['script', 'module']) {
  test(`${type} components optionally strip erasable TypeScript syntax`, async () => {
    const body = `
      interface Message { value: number }
      onMessage((message: Message): number => message.value * 2)
    `
    const source = type === 'script'
      ? body
      : `
        interface Message { value: number }
        export default ({ onMessage }: { onMessage: Function }) => {
          onMessage((message: Message): number => message.value * 2)
        }
      `
    const session = createUntrustedWorker(source, { type, ...SESSION_OPTIONS })
    await session.ready
    assert.equal(await session.request({ value: 21 }), 42)
    await session.terminate()
  })
}

test('TypeScript mode rejects syntax that requires transformation', async () => {
  await assert.rejects(
    runUntrustedCode('enum Value { Answer = 42 }; return Value.Answer', {
      language: 'typescript',
      timeoutMs: 5_000
    }),
    /TypeScript|transform|enum/i
  )
})

test('TypeScript parser failures use stable original-source coordinates', async () => {
  await assert.rejects(
    runUntrustedCode('const value: = 1', {
      language: 'typescript',
      timeoutMs: 5_000
    }),
    (error) => {
      assert.match(error.remoteStack, /secure-eval-worker-one-shot\.ts:1/)
      return true
    }
  )

  for (const [type, filename] of [
    ['script', 'secure-eval-worker-component.ts'],
    ['module', 'secure-eval-worker-component.mts']
  ]) {
    const session = createUntrustedWorker('const value: = 1', {
      type,
      ...SESSION_OPTIONS
    })
    await assert.rejects(session.ready, (error) => {
      assert.match(error.remoteStack, new RegExp(`${filename.replace('.', '\\.')}:1`))
      return true
    })
    await session.closed
  }
})

test('JavaScript remains the default and language is validated', async () => {
  assert.equal(await runUntrustedCode('return 42', { timeoutMs: 5_000 }), 42)
  assert.throws(
    () => runUntrustedCode('return 42', { language: 'coffee' }),
    /language must be/
  )
  assert.throws(
    () => createUntrustedWorker('', { language: 'coffee' }),
    /language must be/
  )
})
