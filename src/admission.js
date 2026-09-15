import { isMainThread } from 'node:worker_threads'

import { UntrustedCodeError } from './internal.js'

const DEFAULT_MAX_CONCURRENT_WORKERS = 4
const MAX_PROCESS_FILE_DESCRIPTORS = 256
const DESCRIPTOR_SLOTS_BYTE_LENGTH = Int32Array.BYTES_PER_ELEMENT *
  MAX_PROCESS_FILE_DESCRIPTORS
// Keep the original worker key so older and newer package copies continue to
// share the same process-wide worker counter.
const STATE_KEY = Symbol.for('secure-eval-worker.admission.main.v1')
const PREPARATION_STATE_KEY = Symbol.for('secure-eval-worker.admission.preparation.main.v1')
const DESCRIPTOR_STATE_KEY = Symbol.for('secure-eval-worker.admission.descriptors.main.v1')
const TypeError = globalThis.TypeError
const RangeError = globalThis.RangeError
const safeAtomics = Atomics
const atomicsCompareExchange = Atomics.compareExchange
const arrayIsArray = Array.isArray
const numberIsSafeInteger = Number.isSafeInteger
const objectDefineProperty = Object.defineProperty
const objectFreeze = Object.freeze
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const objectIsFrozen = Object.isFrozen
const reflectApply = Reflect.apply
const sharedArrayBufferByteLength = Object.getOwnPropertyDescriptor(
  SharedArrayBuffer.prototype,
  'byteLength'
).get
const reflectOwnKeys = Reflect.ownKeys
const setAdd = Set.prototype.add
const setDelete = Set.prototype.delete
const setHas = Set.prototype.has
const weakMapGet = WeakMap.prototype.get
const weakMapSet = WeakMap.prototype.set

function capacityError (message) {
  return new UntrustedCodeError(message, { code: 'ERR_UNTRUSTED_WORKER_CAPACITY' })
}

function createState () {
  let activeWorkers = 0
  let maxConcurrentWorkers = DEFAULT_MAX_CONCURRENT_WORKERS

  return objectFreeze({
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
      return objectFreeze({ maxConcurrentWorkers, activeWorkers })
    }
  })
}

function createDescriptorState () {
  const slotsBuffer = new SharedArrayBuffer(DESCRIPTOR_SLOTS_BYTE_LENGTH)
  const slots = new Int32Array(slotsBuffer)
  const activeOwners = new Set()
  const descriptorQuotaData = new WeakMap()
  let nextOwner = 1

  return objectFreeze({
    createWorkerQuota () {
      while (reflectApply(setHas, activeOwners, [nextOwner])) {
        nextOwner = nextOwner === 0x7fffffff ? 1 : nextOwner + 1
      }
      const owner = nextOwner
      reflectApply(setAdd, activeOwners, [owner])
      nextOwner = nextOwner === 0x7fffffff ? 1 : nextOwner + 1
      let released = false
      const workerData = objectFreeze({ slotsBuffer, owner })
      const release = () => {
        if (released) return
        released = true
        for (let index = 0; index < MAX_PROCESS_FILE_DESCRIPTORS; index++) {
          reflectApply(atomicsCompareExchange, safeAtomics, [slots, index, owner, 0])
        }
        reflectApply(setDelete, activeOwners, [owner])
      }
      // The public shape remains compatible with descriptor-state v1 so an
      // older physical package copy loaded after this one can still release
      // its quota. New copies use the private WeakMap association below.
      const quota = objectFreeze({ slotsBuffer, owner, release })
      reflectApply(weakMapSet, descriptorQuotaData, [
        quota,
        objectFreeze({ release, workerData })
      ])
      return quota
    },

    getWorkerData (quota) {
      const data = reflectApply(weakMapGet, descriptorQuotaData, [quota])
      if (!data) throw new TypeError('Invalid file descriptor quota')
      return data.workerData
    },

    release (quota) {
      const data = reflectApply(weakMapGet, descriptorQuotaData, [quota])
      if (!data) throw new TypeError('Invalid file descriptor quota')
      data.release()
    }
  })
}

function createPreparationState () {
  let activePreparations = 0
  let maxConcurrentPreparations = DEFAULT_MAX_CONCURRENT_WORKERS

  return objectFreeze({
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

const descriptorQuotaData = new WeakMap()
let state
let preparationState
let descriptorState
let stateAcquire
let stateConfigure
let stateStatus
let preparationStateAcquire
let preparationStateConfigure
let descriptorStateCreateWorkerQuota
let descriptorStateGetWorkerData
let descriptorStateRelease
let legacyDescriptorState = false

function immutableStateMethod (candidate, name) {
  const descriptor = reflectApply(
    objectGetOwnPropertyDescriptor,
    Object,
    [candidate, name]
  )
  if (!descriptor || !('value' in descriptor) ||
      typeof descriptor.value !== 'function' || descriptor.writable !== false ||
      descriptor.configurable !== false) return undefined
  return descriptor.value
}

function captureControllerState (candidate, names) {
  if (candidate === null || typeof candidate !== 'object' ||
      !reflectApply(objectIsFrozen, Object, [candidate])) return undefined
  const captured = {}
  for (let index = 0; index < names.length; index++) {
    const method = immutableStateMethod(candidate, names[index])
    if (!method) return undefined
    captured[names[index]] = method
  }
  return objectFreeze(captured)
}

if (isMainThread) {
  state = globalThis[STATE_KEY]
  if (state === undefined) {
    state = createState()
    objectDefineProperty(globalThis, STATE_KEY, {
      value: state,
      configurable: false,
      enumerable: false,
      writable: false
    })
  }

  preparationState = globalThis[PREPARATION_STATE_KEY]
  if (preparationState === undefined) {
    preparationState = createPreparationState()
    objectDefineProperty(globalThis, PREPARATION_STATE_KEY, {
      value: preparationState,
      configurable: false,
      enumerable: false,
      writable: false
    })
  }

  const capturedWorkerState = captureControllerState(state, ['acquire', 'configure', 'status'])
  if (capturedWorkerState) {
    stateAcquire = capturedWorkerState.acquire
    stateConfigure = capturedWorkerState.configure
    stateStatus = capturedWorkerState.status
  }
  const capturedPreparationState = captureControllerState(
    preparationState,
    ['acquire', 'configure']
  )
  if (capturedPreparationState) {
    preparationStateAcquire = capturedPreparationState.acquire
    preparationStateConfigure = capturedPreparationState.configure
  }

  descriptorState = globalThis[DESCRIPTOR_STATE_KEY]
  if (descriptorState === undefined) {
    descriptorState = createDescriptorState()
    objectDefineProperty(globalThis, DESCRIPTOR_STATE_KEY, {
      value: descriptorState,
      configurable: false,
      enumerable: false,
      writable: false
    })
  }

  if (descriptorState !== null && typeof descriptorState === 'object' &&
      reflectApply(objectIsFrozen, Object, [descriptorState])) {
    const createDescriptor = reflectApply(
      objectGetOwnPropertyDescriptor,
      Object,
      [descriptorState, 'createWorkerQuota']
    )
    if (createDescriptor && 'value' in createDescriptor &&
        typeof createDescriptor.value === 'function' &&
        createDescriptor.writable === false && createDescriptor.configurable === false) {
      const getDescriptor = reflectApply(
        objectGetOwnPropertyDescriptor,
        Object,
        [descriptorState, 'getWorkerData']
      )
      const releaseDescriptor = reflectApply(
        objectGetOwnPropertyDescriptor,
        Object,
        [descriptorState, 'release']
      )
      const hasModernMethods = getDescriptor && 'value' in getDescriptor &&
        typeof getDescriptor.value === 'function' &&
        getDescriptor.writable === false && getDescriptor.configurable === false &&
        releaseDescriptor && 'value' in releaseDescriptor &&
        typeof releaseDescriptor.value === 'function' &&
        releaseDescriptor.writable === false && releaseDescriptor.configurable === false
      const hasNoModernMethods = getDescriptor === undefined && releaseDescriptor === undefined
      if (hasModernMethods || hasNoModernMethods) {
        descriptorStateCreateWorkerQuota = createDescriptor.value
        if (hasModernMethods) {
          descriptorStateGetWorkerData = getDescriptor.value
          descriptorStateRelease = releaseDescriptor.value
        } else {
          legacyDescriptorState = true
        }
      }
    }
  }
}

function admissionUnavailableError () {
  return new UntrustedCodeError(
    'Process-wide worker admission state is unavailable or incompatible',
    { code: 'ERR_UNTRUSTED_WORKER_ADMISSION_UNAVAILABLE' }
  )
}

function requireState () {
  if (!state || !preparationState || !descriptorState || !stateAcquire ||
      !stateConfigure || !stateStatus || !preparationStateAcquire ||
      !preparationStateConfigure) {
    throw new UntrustedCodeError(
      'Sandbox workers must be created from the main thread so process-wide admission cannot be orphaned',
      { code: 'ERR_UNTRUSTED_WORKER_ADMISSION_UNAVAILABLE' }
    )
  }
  return state
}

function acquireControllerSlot (receiver, acquire) {
  const release = reflectApply(acquire, receiver, [])
  if (typeof release !== 'function') throw admissionUnavailableError()
  let released = false
  return () => {
    if (released) return
    released = true
    try {
      reflectApply(release, undefined, [])
    } catch {}
  }
}

export function acquireWorkerSlot () {
  requireState()
  return acquireControllerSlot(state, stateAcquire)
}

export function acquireFilePreparationSlot () {
  requireState()
  return acquireControllerSlot(preparationState, preparationStateAcquire)
}

function descriptorAdmissionError () {
  return new UntrustedCodeError(
    'File descriptor admission state is unavailable or incompatible',
    { code: 'ERR_UNTRUSTED_WORKER_ADMISSION_UNAVAILABLE' }
  )
}

function requireDescriptorState () {
  requireState()
  if (!descriptorStateCreateWorkerQuota) throw descriptorAdmissionError()
}

function immutableQuotaDataDescriptor (quota, name) {
  const descriptor = reflectApply(
    objectGetOwnPropertyDescriptor,
    Object,
    [quota, name]
  )
  if (!descriptor || !('value' in descriptor) ||
      descriptor.writable !== false || descriptor.configurable !== false) {
    throw descriptorAdmissionError()
  }
  return descriptor.value
}

function validateDescriptorWorkerData (workerData) {
  if (workerData === null || typeof workerData !== 'object' ||
      !reflectApply(objectIsFrozen, Object, [workerData])) {
    throw descriptorAdmissionError()
  }
  const owner = immutableQuotaDataDescriptor(workerData, 'owner')
  const slotsBuffer = immutableQuotaDataDescriptor(workerData, 'slotsBuffer')
  let slotsByteLength
  try {
    slotsByteLength = reflectApply(sharedArrayBufferByteLength, slotsBuffer, [])
  } catch {
    throw descriptorAdmissionError()
  }
  if (!reflectApply(numberIsSafeInteger, Number, [owner]) ||
      owner <= 0 || owner > 0x7fffffff ||
      slotsByteLength !== DESCRIPTOR_SLOTS_BYTE_LENGTH) {
    throw descriptorAdmissionError()
  }
  return objectFreeze({ owner, slotsBuffer })
}

function brandDescriptorQuota (quota, workerData, releaseHook) {
  const validated = validateDescriptorWorkerData(workerData)
  const slots = new Int32Array(validated.slotsBuffer)
  let released = false
  const release = () => {
    if (released) return
    released = true
    for (let index = 0; index < MAX_PROCESS_FILE_DESCRIPTORS; index++) {
      reflectApply(atomicsCompareExchange, safeAtomics, [
        slots,
        index,
        validated.owner,
        0
      ])
    }
    try {
      reflectApply(releaseHook, undefined, [])
    } catch {}
  }
  reflectApply(weakMapSet, descriptorQuotaData, [
    quota,
    objectFreeze({ release, workerData: validated })
  ])
  return quota
}

function adaptLegacyDescriptorQuota (quota) {
  if (quota === null || typeof quota !== 'object' ||
      !reflectApply(objectIsFrozen, Object, [quota])) {
    throw descriptorAdmissionError()
  }
  const owner = immutableQuotaDataDescriptor(quota, 'owner')
  const slotsBuffer = immutableQuotaDataDescriptor(quota, 'slotsBuffer')
  const capturedRelease = immutableQuotaDataDescriptor(quota, 'release')
  if (typeof capturedRelease !== 'function') throw descriptorAdmissionError()
  const workerData = objectFreeze({ owner, slotsBuffer })
  return brandDescriptorQuota(
    quota,
    workerData,
    () => reflectApply(capturedRelease, quota, [])
  )
}

export function createFileDescriptorQuota () {
  requireDescriptorState()
  let quota
  try {
    quota = reflectApply(descriptorStateCreateWorkerQuota, descriptorState, [])
  } catch (error) {
    if (legacyDescriptorState) throw descriptorAdmissionError()
    throw error
  }
  if (legacyDescriptorState) {
    try {
      return adaptLegacyDescriptorQuota(quota)
    } catch (error) {
      try {
        const release = immutableQuotaDataDescriptor(quota, 'release')
        if (typeof release === 'function') reflectApply(release, quota, [])
      } catch {}
      throw error
    }
  }
  let workerData
  try {
    workerData = reflectApply(descriptorStateGetWorkerData, descriptorState, [quota])
  } catch (error) {
    try {
      reflectApply(descriptorStateRelease, descriptorState, [quota])
    } catch {}
    throw error
  }
  try {
    return brandDescriptorQuota(
      quota,
      workerData,
      () => reflectApply(descriptorStateRelease, descriptorState, [quota])
    )
  } catch (error) {
    try {
      reflectApply(descriptorStateRelease, descriptorState, [quota])
    } catch {}
    throw error
  }
}

export function getFileDescriptorQuotaWorkerData (quota) {
  requireDescriptorState()
  const data = reflectApply(weakMapGet, descriptorQuotaData, [quota])
  if (data) return data.workerData
  if (!descriptorStateGetWorkerData) throw descriptorAdmissionError()
  return reflectApply(descriptorStateGetWorkerData, descriptorState, [quota])
}

export function releaseFileDescriptorQuota (quota) {
  requireDescriptorState()
  const data = reflectApply(weakMapGet, descriptorQuotaData, [quota])
  if (data) {
    data.release()
    return
  }
  if (!descriptorStateRelease) throw descriptorAdmissionError()
  reflectApply(descriptorStateRelease, descriptorState, [quota])
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
  requireState()
  const status = reflectApply(stateConfigure, state, [descriptor.value])
  reflectApply(preparationStateConfigure, preparationState, [descriptor.value])
  return snapshotAdmissionStatus(status)
}

function snapshotAdmissionStatus (status) {
  if (status === null || typeof status !== 'object') throw admissionUnavailableError()
  const maxDescriptor = reflectApply(
    objectGetOwnPropertyDescriptor,
    Object,
    [status, 'maxConcurrentWorkers']
  )
  const activeDescriptor = reflectApply(
    objectGetOwnPropertyDescriptor,
    Object,
    [status, 'activeWorkers']
  )
  const maxConcurrentWorkers = maxDescriptor && 'value' in maxDescriptor
    ? maxDescriptor.value
    : undefined
  const activeWorkers = activeDescriptor && 'value' in activeDescriptor
    ? activeDescriptor.value
    : undefined
  if (!reflectApply(numberIsSafeInteger, Number, [maxConcurrentWorkers]) ||
      maxConcurrentWorkers <= 0 ||
      !reflectApply(numberIsSafeInteger, Number, [activeWorkers]) || activeWorkers < 0) {
    throw admissionUnavailableError()
  }
  return objectFreeze({ maxConcurrentWorkers, activeWorkers })
}

export function getWorkerAdmissionStatus () {
  requireState()
  return snapshotAdmissionStatus(reflectApply(stateStatus, state, []))
}
