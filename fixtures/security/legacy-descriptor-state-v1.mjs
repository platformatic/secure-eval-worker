export function installLegacyDescriptorStateV1 (releaseModes = []) {
  const slotsBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 256)
  const slots = new Int32Array(slotsBuffer)
  let nextOwner = 1
  const state = Object.freeze({
    createWorkerQuota () {
      const owner = nextOwner++
      let released = false
      return Object.freeze({
        owner,
        slotsBuffer,
        release () {
          if (released) return
          released = true
          const mode = releaseModes[owner - 1] ?? 'normal'
          if (mode === 'noop') return
          if (mode === 'throw') throw new Error('legacy release failure')
          for (let index = 0; index < slots.length; index++) {
            Atomics.compareExchange(slots, index, owner, 0)
          }
        }
      })
    }
  })
  Object.defineProperty(
    globalThis,
    Symbol.for('secure-eval-worker.admission.descriptors.main.v1'),
    { value: state }
  )
  return Object.freeze({ slotsBuffer })
}
