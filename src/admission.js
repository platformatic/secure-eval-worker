import { isMainThread } from 'node:worker_threads'

import { UntrustedCodeError } from './internal.js'

const DEFAULT_MAX_CONCURRENT_WORKERS = 4
const MAX_PROCESS_FILE_DESCRIPTORS = 256
// Keep the original worker key so older and newer package copies continue to
// share the same process-wide worker counter.
const STATE_KEY = Symbol.for('secure-eval-worker.admission.main.v1')
const PREPARATION_STATE_KEY = Symbol.for('secure-eval-worker.admission.preparation.main.v1')
const DESCRIPTOR_STATE_KEY = Symbol.for('secure-eval-worker.admission.descriptors.main.v1')
const safeAtomics = Atomics
const atomicsCompareExchange = Atomics.compareExchange
const arrayIsArray = Array.isArray
const numberIsSafeInteger = Number.isSafeInteger
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const reflectApply = Reflect.apply
const reflectOwnKeys = Reflect.ownKeys
const setAdd = Set.prototype.add
const setDelete = Set.prototype.delete
const setHas = Set.prototype.has

function capacityError (message) {
  return new UntrustedCodeError(message, { code: 'ERR_UNTRUSTED_WORKER_CAPACITY' })
}

function createState () {
  let activeWorkers = 0
  let maxConcurrentWorkers = DEFAULT_MAX_CONCURRENT_WORKERS

  return Object.freeze({
    acquire () {
      if (activeWorkers >= maxConcurrentWorkers) {
        throw capacityError(`Worker capacity exhausted (${maxConcurrentWorkers} active workers)`)
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

function createDescriptorState () {
  const slotsBuffer = new SharedArrayBuffer(
    Int32Array.BYTES_PER_ELEMENT * MAX_PROCESS_FILE_DESCRIPTORS
  )
  const slots = new Int32Array(slotsBuffer)
  const activeOwners = new Set()
  let nextOwner = 1

  return Object.freeze({
    createWorkerQuota () {
      while (reflectApply(setHas, activeOwners, [nextOwner])) {
        nextOwner = nextOwner === 0x7fffffff ? 1 : nextOwner + 1
      }
      const owner = nextOwner
      reflectApply(setAdd, activeOwners, [owner])
      nextOwner = nextOwner === 0x7fffffff ? 1 : nextOwner + 1
      let released = false
      return Object.freeze({
        slotsBuffer,
        owner,
        release () {
          if (released) return
          released = true
          for (let index = 0; index < slots.length; index++) {
            reflectApply(atomicsCompareExchange, safeAtomics, [slots, index, owner, 0])
          }
          reflectApply(setDelete, activeOwners, [owner])
        }
      })
    }
  })
}

function createPreparationState () {
  let activePreparations = 0
  let maxConcurrentPreparations = DEFAULT_MAX_CONCURRENT_WORKERS

  return Object.freeze({
    acquire () {
      if (activePreparations >= maxConcurrentPreparations) {
        throw capacityError(
          `File preparation capacity exhausted (${maxConcurrentPreparations} active preparations)`
        )
      }
      activePreparations++
      let released = false
      return () => {
        if (released) return
        released = true
        activePreparations--
      }
    },

    configure (maxPreparations) {
      maxConcurrentPreparations = maxPreparations
    }
  })
}

let state
let preparationState
let descriptorState
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

  preparationState = globalThis[PREPARATION_STATE_KEY]
  if (preparationState === undefined) {
    preparationState = createPreparationState()
    Object.defineProperty(globalThis, PREPARATION_STATE_KEY, {
      value: preparationState,
      configurable: false,
      enumerable: false,
      writable: false
    })
  }

  descriptorState = globalThis[DESCRIPTOR_STATE_KEY]
  if (descriptorState === undefined) {
    descriptorState = createDescriptorState()
    Object.defineProperty(globalThis, DESCRIPTOR_STATE_KEY, {
      value: descriptorState,
      configurable: false,
      enumerable: false,
      writable: false
    })
  }
}

function requireState () {
  if (!state || !preparationState || !descriptorState) {
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

export function acquireFilePreparationSlot () {
  requireState()
  return preparationState.acquire()
}

export function createFileDescriptorQuota () {
  requireState()
  return descriptorState.createWorkerQuota()
}

export function configureWorkerAdmission (options) {
  if (options === null || typeof options !== 'object' ||
      reflectApply(arrayIsArray, Array, [options])) {
    throw new TypeError('admission options must be an object')
  }
  const keys = reflectOwnKeys(options)
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]
    if (typeof key === 'symbol') {
      throw new TypeError('admission options must not contain symbol properties')
    }
    if (key !== 'maxConcurrentWorkers') {
      throw new TypeError(`Unknown admission option: ${key}`)
    }
  }
  const descriptor = reflectApply(
    objectGetOwnPropertyDescriptor,
    Object,
    [options, 'maxConcurrentWorkers']
  )
  if (!descriptor || !('value' in descriptor)) {
    throw new TypeError('maxConcurrentWorkers must be a data property')
  }
  if (!reflectApply(numberIsSafeInteger, Number, [descriptor.value]) || descriptor.value <= 0) {
    throw new RangeError('maxConcurrentWorkers must be a positive integer')
  }
  const admissionState = requireState()
  const status = admissionState.configure(descriptor.value)
  preparationState.configure(descriptor.value)
  return status
}

export function getWorkerAdmissionStatus () {
  return requireState().status()
}
