import { isMainThread } from 'node:worker_threads'

import { UntrustedCodeError } from './internal.js'

const DEFAULT_MAX_CONCURRENT_WORKERS = 4
const STATE_KEY = Symbol.for('secure-eval-worker.admission.main.v1')

function createState () {
  let activeWorkers = 0
  let maxConcurrentWorkers = DEFAULT_MAX_CONCURRENT_WORKERS

  return Object.freeze({
    acquire () {
      if (activeWorkers >= maxConcurrentWorkers) {
        throw new UntrustedCodeError(
          `Worker capacity exhausted (${maxConcurrentWorkers} active workers)`,
          { code: 'ERR_UNTRUSTED_WORKER_CAPACITY' }
        )
      }
      activeWorkers++
      let released = false
      return () => {
        if (released) return
        released = true
        activeWorkers--
      }
    },

    configure (maxWorkers) {
      maxConcurrentWorkers = maxWorkers
      return this.status()
    },

    status () {
      return Object.freeze({ maxConcurrentWorkers, activeWorkers })
    }
  })
}

let state
if (isMainThread) {
  state = globalThis[STATE_KEY]
  if (state === undefined) {
    state = createState()
    Object.defineProperty(globalThis, STATE_KEY, {
      value: state,
      configurable: false,
      enumerable: false,
      writable: false
    })
  }
}

function requireState () {
  if (!state) {
    throw new UntrustedCodeError(
      'Sandbox workers must be created from the main thread so process-wide admission cannot be orphaned',
      { code: 'ERR_UNTRUSTED_WORKER_ADMISSION_UNAVAILABLE' }
    )
  }
  return state
}

export function acquireWorkerSlot () {
  return requireState().acquire()
}

export function configureWorkerAdmission (options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('admission options must be an object')
  }
  const keys = Reflect.ownKeys(options)
  if (keys.some((key) => typeof key === 'symbol')) {
    throw new TypeError('admission options must not contain symbol properties')
  }
  const unknown = keys.filter((key) => key !== 'maxConcurrentWorkers')
  if (unknown.length > 0) {
    throw new TypeError(`Unknown admission option: ${unknown[0]}`)
  }
  const descriptor = Object.getOwnPropertyDescriptor(options, 'maxConcurrentWorkers')
  if (!descriptor || !('value' in descriptor)) {
    throw new TypeError('maxConcurrentWorkers must be a data property')
  }
  if (!Number.isSafeInteger(descriptor.value) || descriptor.value <= 0) {
    throw new RangeError('maxConcurrentWorkers must be a positive integer')
  }
  return requireState().configure(descriptor.value)
}

export function getWorkerAdmissionStatus () {
  return requireState().status()
}
