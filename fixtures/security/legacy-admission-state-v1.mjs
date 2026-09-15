const WORKER_KEY = Symbol.for('secure-eval-worker.admission.main.v1')
const PREPARATION_KEY = Symbol.for('secure-eval-worker.admission.preparation.main.v1')

export function legacyAcquireWorkerV1 () {
  return globalThis[WORKER_KEY].acquire()
}

export function legacyConfigureWorkersV1 (maximum) {
  return globalThis[WORKER_KEY].configure(maximum)
}

export function legacyWorkerStatusV1 () {
  return globalThis[WORKER_KEY].status()
}

export function legacyAcquirePreparationV1 () {
  return globalThis[PREPARATION_KEY].acquire()
}

export function legacyConfigurePreparationsV1 (maximum) {
  return globalThis[PREPARATION_KEY].configure(maximum)
}

export function installLegacyAdmissionStateV1 () {
  let activeWorkers = 0
  let maxConcurrentWorkers = 4
  const workerState = Object.freeze({
    acquire () {
      if (activeWorkers >= maxConcurrentWorkers) {
        const error = new Error('legacy worker capacity exhausted')
        error.code = 'ERR_UNTRUSTED_WORKER_CAPACITY'
        throw error
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
  let activePreparations = 0
  let maxConcurrentPreparations = 4
  const preparationState = Object.freeze({
    acquire () {
      if (activePreparations >= maxConcurrentPreparations) {
        const error = new Error('legacy preparation capacity exhausted')
        error.code = 'ERR_UNTRUSTED_WORKER_CAPACITY'
        throw error
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
  Object.defineProperty(
    globalThis,
    WORKER_KEY,
    { value: workerState }
  )
  Object.defineProperty(
    globalThis,
    PREPARATION_KEY,
    { value: preparationState }
  )
}
