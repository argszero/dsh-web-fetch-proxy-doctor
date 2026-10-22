/**
 * Mutation harness: every arm breaks one decision the plugin makes, and the
 * suite must notice. A survivor is a predicate nothing tests.
 *
 * The control arm runs first — unmutated source must pass — because a harness
 * that reports every arm as caught while the suite is already red proves
 * nothing. The source is restored in a `finally` and verified by hash, so an
 * interrupted run cannot leave a mutated file behind to be trusted later.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = join(root, 'lib', 'index.js')
const original = readFileSync(source, 'utf8')
const originalHash = createHash('sha256').update(original).digest('hex')

/** Each arm is one plausible mistake, not a random edit. */
const arms = [
  ['tool-name', "export const TOOL = 'web_fetch'", "export const TOOL = 'fetch'"],
  ['error-flag', '  if (result?.isError !== true) return undefined', '  if (result?.isError !== false) return undefined'],
  ['error-code', '  if (result?.error?.info?.code !== CODE) return undefined', '  if (result?.error?.info?.code === undefined) return undefined'],
  ['proxy-asked', '  if (named.length === 0) return undefined', '  if (named.length > 0) return undefined'],
  ['policy-probe', '  if (!hasInstalledPolicy()) {', '  if (hasInstalledPolicy()) {'],
  ['probe-result', '    return Object.keys(proxyEnvironmentForChild()).length > 0', '    return false'],
  ['bypass-filter', '    if (BYPASS_ONLY_NAMES.has(key.toLowerCase())) continue', '    if (false) continue'],
  ['route-branch', "  return { state: proxied ? 'literal' : 'bypassed', hostname: url.hostname, named, url: url.toString() }",
    "  return { state: 'bypassed', hostname: url.hostname, named, url: url.toString() }"],
  ['message-branch', "  if (diagnosis.state === 'no-policy') {", "  if (diagnosis.state === 'bypassed') {"],
  ['decision-kind', "  if (decision?.kind !== 'accept') return decision", "  if (decision?.kind === 'accept') return decision"],
  ['content-kept', "  return { ...decision, content: [...base, { type: 'text', text: messageFor(diagnosis) }] }",
    "  return { ...decision, content: [{ type: 'text', text: messageFor(diagnosis) }] }"],
  ['chain-runs', '    if (diagnosis === undefined) return next()', "    if (diagnosis === undefined) return { kind: 'accept' }"],
]

/** Run the suite; report whether it failed. */
function suiteFails() {
  try {
    execFileSync(process.execPath, ['--test', '--test-timeout=30000', 'test/doctor.spec.mjs', 'test/wire.spec.mjs'], {
      cwd: root, stdio: 'ignore', timeout: 120_000, env: { ...process.env, PATH: process.env.PATH },
    })
    return false
  } catch {
    return true
  }
}

let survivors = 0
try {
  const control = suiteFails()
  console.log(`control (unmutated): ${control ? 'FAIL — the suite is red before any arm' : 'PASS'}`)
  if (control) {
    console.log('refusing to grade arms against a failing suite')
    process.exitCode = 1
  } else {
    for (const [label, find, replace] of arms) {
      const hits = original.split(find).length - 1
      if (hits !== 1) {
        console.log(`${label}: NO-OP — anchor matched ${hits} times, not 1`)
        survivors += 1
        continue
      }
      writeFileSync(source, original.replace(find, replace))
      let killed = false
      try {
        killed = suiteFails()
      } finally {
        writeFileSync(source, original)
      }
      console.log(`${label}: ${killed ? 'CAUGHT' : 'SURVIVED'}`)
      if (!killed) survivors += 1
    }
  }
} finally {
  writeFileSync(source, original)
  const restored = createHash('sha256').update(readFileSync(source, 'utf8')).digest('hex')
  console.log(`source restored: ${restored === originalHash ? 'verified' : 'MISMATCH'}`)
  if (restored !== originalHash) process.exitCode = 1
}

console.log(`\narms: ${arms.length}, survivors: ${survivors}`)
if (survivors > 0) process.exitCode = 1
