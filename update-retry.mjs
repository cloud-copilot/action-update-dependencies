import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

/**
 * Extract a single unambiguous public scoped tarball E404 from npm stderr.
 * @param {string} stderr - Captured npm error output.
 * @returns {{name: string, version: string, url: string} | null} Eligible target or null.
 */
export function getCandidate(stderr) {
  const lines = stderr.split(/\r?\n/)
  const codes = lines.filter((line) => /^npm error code /.test(line))
  if (codes.length !== 1 || codes[0] !== 'npm error code E404') {
    return null
  }
  const errors = lines.filter((line) => line.startsWith('npm error '))
  if (errors.some((line) => !/^npm error (?:code E404$|404(?:\s|$)|A complete log of this run can be found in:)/.test(line))) {
    return null
  }
  const gets = errors.filter((line) => /^npm error 404 Not Found - GET /.test(line))
  if (gets.length !== 1) {
    return null
  }
  const match = gets[0].match(/^npm error 404 Not Found - GET (https:\/\/registry\.npmjs\.org\/@actsecurity\/([a-z0-9][a-z0-9._-]*)\/-\/\2-(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)\.tgz) - Not found$/)
  if (!match) {
    return null
  }
  return { name: `@actsecurity/${match[2]}`, version: match[3], url: match[1] }
}

/**
 * Validate that metadata identifies the exact recently published tarball.
 * @param {{name: string, version: string, url: string}} candidate - Parsed target.
 * @param {any} metadata - Public registry package document.
 * @param {number} now - Current Unix milliseconds.
 * @returns {boolean} Whether retry is eligible.
 */
export function isRecent(candidate, metadata, now) {
  const published = Date.parse(metadata?.time?.[candidate.version])
  return metadata?.name === candidate.name &&
    metadata?.versions?.[candidate.version]?.dist?.tarball === candidate.url &&
    Number.isFinite(published) && published <= now && now - published <= 600_000
}

/**
 * Run npm update, retrying only verified recent tarball E404 failures.
 * @param {object} options - Injectable command, metadata and timing operations.
 * @param {Function} options.execute - Execute one update attempt.
 * @param {Function} options.fetchMetadata - Retrieve public metadata for a candidate.
 * @param {Function} options.now - Return current Unix milliseconds.
 * @param {Function} options.sleep - Wait a number of seconds.
 * @param {Function} options.log - Report retry diagnostics.
 * @returns {Promise<number>} Last update exit code.
 */
export async function runUpdate({ execute, fetchMetadata, now, sleep, log }) {
  const waits = [60, 120]
  for (let attempt = 0; ; attempt += 1) {
    const { status, stderr } = await execute()
    if (status === 0 || attempt >= waits.length) {
      return status
    }
    const candidate = getCandidate(stderr)
    if (!candidate) {
      return status
    }
    let metadata
    try {
      metadata = await fetchMetadata(candidate)
    } catch {
      log('Unable to verify public npm metadata; not retrying.')
      return status
    }
    if (!isRecent(candidate, metadata, now())) {
      return status
    }
    log(`Recent public npm tarball returned 404; retrying npm update in ${waits[attempt]} seconds.`)
    await sleep(waits[attempt])
  }
}

/**
 * Execute npm update while forwarding output and retaining bounded stderr for classification.
 * @returns {Promise<{status: number, stderr: string}>} Exit status and captured stderr.
 */
function executeUpdate() {
  return new Promise((resolve) => {
    const child = spawn('npm', ['update'], { stdio: ['inherit', 'inherit', 'pipe'] })
    let stderr = ''
    let overflow = false
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk)
      if (stderr.length + chunk.length > 1_000_000) {
        overflow = true
      } else if (!overflow) {
        stderr += chunk.toString()
      }
    })
    child.on('error', (error) => {
      console.error(`Unable to execute npm update: ${error.message}`)
      resolve({ status: 1, stderr: '' })
    })
    child.on('close', (code) => resolve({ status: code ?? 1, stderr: overflow ? '' : stderr }))
  })
}

/**
 * Fetch a bounded public registry package document without following redirects.
 * @param {{name: string}} candidate - Public npm package name.
 * @returns {Promise<object>} Registry metadata.
 */
async function fetchMetadata(candidate) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(candidate.name)}`, {
    redirect: 'error',
    signal: AbortSignal.timeout(5000)
  })
  if (!response.ok) {
    throw new Error('Registry metadata unavailable')
  }
  const text = await response.text()
  if (text.length > 10_000_000) {
    throw new Error('Registry metadata too large')
  }
  return JSON.parse(text)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runUpdate({
    execute: executeUpdate,
    fetchMetadata,
    now: Date.now,
    sleep: (seconds) => delay(seconds * 1000),
    log: (message) => console.error(message)
  })
}
