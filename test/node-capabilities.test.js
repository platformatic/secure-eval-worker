import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  descriptorSignature,
  diffExactLists,
  diffSurfaceSignatures
} from '../scripts/node-capability-signatures.js'

test('capability signatures reject synthetic API drift without invoking accessors', () => {
  let getterCalls = 0
  const baseline = Object.create(null)
  Object.defineProperty(baseline, 'stable', {
    enumerable: true,
    value: 1
  })
  Object.defineProperty(baseline, 'lazy', {
    enumerable: true,
    get () {
      getterCalls++
      throw new Error('accessor must not run')
    }
  })
  const expected = descriptorSignature(baseline)
  assert.equal(getterCalls, 0)

  const addedSymbol = Symbol('new-capability')
  const changed = Object.create(null)
  Object.defineProperty(changed, 'stable', {
    enumerable: true,
    value: () => 'new callable'
  })
  Object.defineProperty(changed, 'lazy', {
    enumerable: true,
    get () {
      getterCalls++
      throw new Error('accessor must not run')
    }
  })
  Object.defineProperty(changed, 'addedAccessor', {
    get () {
      getterCalls++
      throw new Error('accessor must not run')
    }
  })
  Object.defineProperty(changed, addedSymbol, {
    value: () => 'new symbolic callable'
  })

  const actual = descriptorSignature(changed)
  const diff = diffSurfaceSignatures(expected, actual)
  assert.equal(getterCalls, 0)
  assert.deepEqual(diff.added, [
    '@@new-capability:f',
    'addedAccessor:a',
    'stable:f'
  ])
  assert.deepEqual(diff.removed, ['stable:n'])
})

test('capability comparisons distinguish module and namespace additions from removals', () => {
  assert.deepEqual(
    diffExactLists(['node:approved', 'node:removed'], ['node:approved', 'node:new']),
    { added: ['node:new'], removed: ['node:removed'] }
  )
  assert.deepEqual(
    diffSurfaceSignatures(['default:o', 'stable:n'], ['default:o', 'future:f'], {
      namesOnly: true
    }),
    { added: ['future:f'], removed: ['stable:n'] }
  )
})

test('constructor prototype additions are visible to the graph signature', () => {
  class Reviewed {}
  const expected = descriptorSignature(Reviewed.prototype)
  Object.defineProperty(Reviewed.prototype, 'futureAuthority', {
    value () {}
  })
  assert.deepEqual(diffSurfaceSignatures(
    expected,
    descriptorSignature(Reviewed.prototype)
  ), {
    added: ['futureAuthority:f'],
    removed: []
  })
})
