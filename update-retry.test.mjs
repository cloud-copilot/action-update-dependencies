import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getCandidate, isRecent, runUpdate } from './update-retry.mjs'

const url = 'https://registry.npmjs.org/@actsecurity/example/-/example-1.2.3.tgz'
const failure = `npm error code E404\nnpm error 404 Not Found - GET ${url} - Not found\nnpm error 404  The requested resource '@actsecurity/example@${url}' could not be found or you do not have permission to access it.\n`
const candidate = { name: '@actsecurity/example', version: '1.2.3', url }
const now = Date.parse('2026-11-07T09:11:00Z')
const metadata = { name: candidate.name, versions: { '1.2.3': { dist: { tarball: url } } }, time: { '1.2.3': '2026-11-07T09:10:00Z' } }

describe('recent tarball classification', () => {
  it('accepts the npm 12 E404 form and rejects unrelated or ambiguous errors', () => {
    assert.deepEqual(getCandidate(failure), candidate)
    const observed = 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@actsecurity/iam-utils/-/iam-utils-0.1.97.tgz - Not found\nnpm error 404\nnpm error 404  The requested resource could not be found or you do not have permission to access it.\nnpm error 404\nnpm error 404 Note that you can also install from a\nnpm error 404 tarball, folder, http url, or git url.\n'
    assert.deepEqual(getCandidate(observed), { name: '@actsecurity/iam-utils', version: '0.1.97', url: 'https://registry.npmjs.org/@actsecurity/iam-utils/-/iam-utils-0.1.97.tgz' })
    for (const text of [failure.replace('E404', 'E403'), failure.replace('registry.npmjs.org', 'private.example'), failure.replace('.tgz', '.json'), `${failure}npm error code E401\n`, `${failure}npm error 404 Not Found - GET ${url.replace('1.2.3', '1.2.4')} - Not found\n`, 'npm error code E404\n']) {
      assert.equal(getCandidate(text), null)
    }
  })

  it('checks exact package, tarball and non-future recent version timestamp', () => {
    assert.equal(isRecent(candidate, metadata, now), true)
    assert.equal(isRecent(candidate, { ...metadata, time: { '1.2.3': '2026-11-07T09:01:00Z' } }, now), true)
    for (const invalid of [null, {}, { ...metadata, name: 'other' }, { ...metadata, time: {} }, { ...metadata, time: { '1.2.3': '2026-11-07T09:11:01Z' } }, { ...metadata, time: { '1.2.3': '2026-11-07T09:00:00Z' } }, { ...metadata, versions: { '1.2.3': { dist: { tarball: `${url}?x=1` } } } }]) {
      assert.equal(isRecent(candidate, invalid, now), false)
    }
  })
})

describe('bounded npm update retry', () => {
  async function scenario(results, getMetadata = async () => metadata) {
    const waits = []
    const logs = []
    let calls = 0
    const result = await runUpdate({
      execute: async () => results[Math.min(calls++, results.length - 1)],
      fetchMetadata: getMetadata,
      now: () => now,
      sleep: async (seconds) => { waits.push(seconds) },
      log: (message) => { logs.push(message) }
    })
    return { result, calls, waits, logs }
  }

  it('does not retry success', async () => {
    const actual = await scenario([{ status: 0, stderr: '' }])
    assert.equal(actual.result, 0)
    assert.equal(actual.calls, 1)
    assert.deepEqual(actual.waits, [])
  })

  it('retries an eligible failure and stops on success', async () => {
    const actual = await scenario([{ status: 1, stderr: failure }, { status: 0, stderr: '' }])
    assert.equal(actual.result, 0)
    assert.equal(actual.calls, 2)
    assert.deepEqual(actual.waits, [60])
  })

  it('exhausts exactly two retries and returns the final exit status', async () => {
    const actual = await scenario([{ status: 1, stderr: failure }, { status: 2, stderr: failure }, { status: 3, stderr: failure }])
    assert.equal(actual.result, 3)
    assert.equal(actual.calls, 3)
    assert.deepEqual(actual.waits, [60, 120])
  })

  it('rechecks eligibility after each failed attempt', async () => {
    let checks = 0
    const actual = await scenario([{ status: 1, stderr: failure }], async () => {
      checks += 1
      return checks === 1 ? metadata : {}
    })
    assert.equal(actual.result, 1)
    assert.equal(actual.calls, 2)
    assert.deepEqual(actual.waits, [60])
  })

  it('fails closed for unrelated errors and unavailable or stale metadata', async () => {
    for (const [stderr, lookup] of [[failure.replace('E404', 'E401'), async () => metadata], [failure, async () => { throw new Error('offline') }], [failure, async () => ({})]]) {
      const actual = await scenario([{ status: 7, stderr }], lookup)
      assert.equal(actual.result, 7)
      assert.equal(actual.calls, 1)
      assert.deepEqual(actual.waits, [])
    }
  })
})
