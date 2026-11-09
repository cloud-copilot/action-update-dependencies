import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

it('runs the action step from a consumer directory and recovers from a recent tarball 404', () => {
  const root = mkdtempSync(join(tmpdir(), 'update-action-test-'))
  try {
    const count = join(root, 'count')
    const fakeNpm = `#!/bin/sh\nif [ "$1" = install ]; then exit 0; fi\nif [ ! -f "$COUNT" ]; then echo 1 > "$COUNT"; echo 'npm error code E404' >&2; echo 'npm error 404 Not Found - GET https://registry.npmjs.org/@actsecurity/example/-/example-1.2.3.tgz - Not found' >&2; exit 1; fi\necho 2 > "$COUNT"\nexit 0\n`
    writeFileSync(join(root, 'npm'), fakeNpm, { mode: 0o755 })
    const preload = `const timers = require('node:timers/promises'); timers.setTimeout = async () => {}; require('node:module').syncBuiltinESMExports(); global.fetch = async () => ({ok:true,text:async () => JSON.stringify({name:'@actsecurity/example',versions:{'1.2.3':{dist:{tarball:'https://registry.npmjs.org/@actsecurity/example/-/example-1.2.3.tgz'}}},time:{'1.2.3':new Date().toISOString()}})});`
    const preloadPath = join(root, 'preload.cjs')
    writeFileSync(preloadPath, preload)
    const action = readFileSync(new URL('./action.yml', import.meta.url), 'utf8')
    // This intentionally extracts the composite step whose wiring is under test.
    const match = action.match(/- name: Update Dependencies\n[\s\S]*?\n\s+run: \|\n((?: {8}.*\n)+)/)
    assert.ok(match, 'action update step exists')
    const script = match[1].split('\n').map((line) => line.slice(8)).join('\n')
    const result = spawnSync('bash', ['-e', '-c', script], {
      cwd: root,
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, COUNT: count, ACTION_PATH: dirname(fileURLToPath(import.meta.url)), NODE_OPTIONS: `--require=${preloadPath}` },
      encoding: 'utf8'
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(count, 'utf8').trim(), '2')
    assert.match(result.stderr, /npm error code E404/)
    assert.match(result.stderr, /retrying npm update in 60 seconds/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('stops before later steps on an unrelated update failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'update-action-failure-'))
  try {
    writeFileSync(join(root, 'npm'), '#!/bin/sh\nif [ "$1" = install ]; then exit 0; fi\necho "npm error code E401" >&2\nexit 7\n', { mode: 0o755 })
    const action = readFileSync(new URL('./action.yml', import.meta.url), 'utf8')
    const match = action.match(/- name: Update Dependencies\n[\s\S]*?\n\s+run: \|\n((?: {8}.*\n)+)/)
    assert.ok(match)
    const script = `${match[1].split('\n').map((line) => line.slice(8)).join('\n')}\necho must-not-run`
    const result = spawnSync('bash', ['-e', '-c', script], {
      cwd: root,
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, ACTION_PATH: dirname(fileURLToPath(import.meta.url)) },
      encoding: 'utf8'
    })
    assert.equal(result.status, 7)
    assert.match(result.stderr, /npm error code E401/)
    assert.doesNotMatch(result.stdout, /must-not-run/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
