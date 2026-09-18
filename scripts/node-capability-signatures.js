export function descriptorSignature (value) {
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return Reflect.ownKeys(descriptors).map(key => {
    const descriptor = descriptors[key]
    const name = typeof key === 'symbol'
      ? `@@${Symbol.keyFor(key) ?? key.description ?? ''}`
      : key
    let kind
    if (!Object.hasOwn(descriptor, 'value')) kind = 'a'
    else if (descriptor.value === null) kind = 'l'
    else {
      kind = {
        bigint: 'i',
        boolean: 'b',
        function: 'f',
        number: 'n',
        object: 'o',
        string: 's',
        symbol: 'y',
        undefined: 'u'
      }[typeof descriptor.value]
    }
    return `${name}:${kind}`
  }).sort()
}

export function diffExactLists (expected, actual) {
  const expectedSet = new Set(expected)
  const actualSet = new Set(actual)
  return {
    added: actual.filter(value => !expectedSet.has(value)),
    removed: expected.filter(value => !actualSet.has(value))
  }
}

export function diffSurfaceSignatures (expected, actual, { namesOnly = false } = {}) {
  const normalize = signature => namesOnly
    ? signature.slice(0, signature.lastIndexOf(':'))
    : signature
  const expectedNames = expected.map(normalize)
  const actualNames = actual.map(normalize)
  const expectedSet = new Set(expectedNames)
  const actualSet = new Set(actualNames)
  return {
    added: actual.filter((value, index) => !expectedSet.has(actualNames[index])),
    removed: expected.filter((value, index) => !actualSet.has(expectedNames[index]))
  }
}
