/**
 * Unit matrix for the diagnosis: each arm fixes one input and asserts the exact
 * state, so a mutation that flips a predicate has somewhere to fail.
 *
 * The policy-bearing arms use the real `installProxyFromEnvironment` and dispose
 * it in a `finally`: the plugin reads module state the library owns, so mocking
 * it would test the mock, and leaking it into the next arm would test the wrong
 * state.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'

import {
  CODE,
  TOOL,
  createDoctor,
  diagnose,
  messageFor,
  proxyNamesInEnvironment,
} from '../lib/index.js'

/** The environment a user configures for a local proxy, in the casing they would export. */
const PROXY_ENV = {
  http_proxy: 'http://127.0.0.1:7897',
  https_proxy: 'http://127.0.0.1:7897',
  no_proxy: 'localhost,127.0.0.1',
}

/** No proxy was asked for. */
const NO_PROXY_ENV = {}

/** The `EnvLookup` shape the shipped install expects: a name resolves to its wrapped value. */
function lookup(env) {
  return { get: (name) => (env[name] === undefined ? undefined : { value: env[name] }) }
}

/** Install a real policy for the duration of `body`, then remove it. */
async function withPolicy(body, env = PROXY_ENV) {
  const dispose = await installProxyFromEnvironment(lookup(env), () => {})
  try {
    return await body()
  } finally {
    await dispose()
  }
}

/** The shape the registry produces for a thrown `WebError`. */
function blockedResult(message = 'URL hostname "api-docs.deepseek.com" resolves to a non-public IP address') {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
    error: { message, info: { name: 'WebError', code: CODE } },
  }
}

/** The shape the registry produces for a successful call. */
function successResult() {
  return { content: [{ type: 'text', text: 'page text' }], isError: false }
}

/** One `web_fetch` execution. */
function call(url = 'https://api-docs.deepseek.com/') {
  return { callId: 'c1', name: TOOL, arguments: { url } }
}

/** A `next()` that records that the rest of the chain ran. */
function countingNext(decision = { kind: 'accept' }) {
  const box = { calls: 0 }
  return [box, async () => { box.calls += 1; return decision }]
}

describe('the predicate', () => {
  it('stays silent for a tool other than web_fetch', async () => {
    const exec = { callId: 'c1', name: 'bash', arguments: { url: 'https://a.example/' } }
    assert.equal(diagnose(exec, blockedResult(), PROXY_ENV), undefined)
  })

  it('stays silent when the call succeeded — the control against a noisy diagnostic', async () => {
    assert.equal(diagnose(call(), successResult(), PROXY_ENV), undefined)
  })

  it('stays silent for a failure carrying another code', async () => {
    const other = {
      content: [{ type: 'text', text: 'Error: nope' }],
      isError: true,
      error: { message: 'nope', info: { name: 'WebError', code: 'WEB_UNSUPPORTED_CONTENT_TYPE' } },
    }
    assert.equal(diagnose(call(), other, PROXY_ENV), undefined)
  })

  it('stays silent when the arguments carry no usable URL', async () => {
    assert.equal(diagnose({ callId: 'c1', name: TOOL, arguments: {} }, blockedResult(), PROXY_ENV), undefined)
    assert.equal(diagnose({ callId: 'c1', name: TOOL, arguments: { url: 'not a url' } }, blockedResult(), PROXY_ENV), undefined)
  })

  it('stays silent when no proxy was ever named — the guard is doing its job', async () => {
    assert.equal(diagnose(call(), blockedResult(), NO_PROXY_ENV), undefined)
  })

  it('stays silent when only a bypass list was exported, since that asks for no proxy', async () => {
    assert.equal(diagnose(call(), blockedResult(), { no_proxy: 'localhost,127.0.0.1' }), undefined)
  })
})

describe('the three routing states', () => {
  it('reports no-policy when the environment names a proxy and none is installed', async () => {
    const diagnosis = diagnose(call(), blockedResult(), PROXY_ENV)
    assert.equal(diagnosis?.state, 'no-policy')
    assert.equal(diagnosis?.hostname, 'api-docs.deepseek.com')
    assert.deepEqual(diagnosis?.named.sort(), ['http_proxy', 'https_proxy'])
  })

  it('reports bypassed when a policy is installed and the URL is exempt from it', async () => {
    const diagnosis = await withPolicy(async () => diagnose(call('https://localhost/'), blockedResult(), PROXY_ENV))
    assert.equal(diagnosis?.state, 'bypassed')
  })

  it('reports literal when a policy is installed, the URL is proxied, yet it was still checked', async () => {
    const diagnosis = await withPolicy(async () => diagnose(call('https://10.0.0.1/'), blockedResult(), PROXY_ENV))
    assert.equal(diagnosis?.state, 'literal')
  })

  it('reports bypassed, not literal, for a no_proxy entry that is otherwise routable', async () => {
    const env = { ...PROXY_ENV, no_proxy: 'internal.example' }
    const diagnosis = await withPolicy(
      async () => diagnose(call('https://internal.example/'), blockedResult(), env),
      env,
    )
    assert.equal(diagnosis?.state, 'bypassed')
  })

  it('returns to no-policy once the policy is disposed', async () => {
    await withPolicy(async () => undefined)
    assert.equal(diagnose(call(), blockedResult(), PROXY_ENV)?.state, 'no-policy')
  })
})

describe('the environment probe', () => {
  it('reads both casings and ignores empty values', () => {
    assert.deepEqual(proxyNamesInEnvironment({}).sort(), [])
    assert.deepEqual(proxyNamesInEnvironment({ http_proxy: '' }).sort(), [])
    assert.deepEqual(proxyNamesInEnvironment({ HTTP_PROXY: 'http://127.0.0.1:1' }).sort(), ['HTTP_PROXY'])
    assert.deepEqual(
      proxyNamesInEnvironment({ http_proxy: 'a', ALL_PROXY: 'b', no_proxy: 'c' }).sort(),
      ['ALL_PROXY', 'http_proxy'],
    )
  })
})

describe('the message', () => {
  it('names the plugin in every state, so the text is attributable', async () => {
    const states = [
      diagnose(call(), blockedResult(), PROXY_ENV),
      await withPolicy(async () => diagnose(call('https://localhost/'), blockedResult(), PROXY_ENV)),
      await withPolicy(async () => diagnose(call('https://10.0.0.1/'), blockedResult(), PROXY_ENV)),
    ]
    for (const diagnosis of states) {
      assert.ok(diagnosis !== undefined)
      assert.ok(messageFor(diagnosis).startsWith('@argszero/dsh-web-fetch-proxy-doctor:'), messageFor(diagnosis))
      assert.ok(messageFor(diagnosis).includes(diagnosis.hostname))
    }
  })

  it('says nothing about a policy when there is none', async () => {
    const diagnosis = diagnose(call(), blockedResult(), PROXY_ENV)
    assert.ok(diagnosis !== undefined)
    assert.match(messageFor(diagnosis), /no proxy policy installed/)
    assert.match(messageFor(diagnosis), /http_proxy/)
  })
})

describe('the observer', () => {
  it('always runs the rest of the chain, even when it has something to say', async () => {
    const doctor = createDoctor({ env: PROXY_ENV })
    const [counter, next] = countingNext()
    await doctor.handle(call(), blockedResult(), next)
    assert.equal(counter.calls, 1)
  })

  it('appends its block after the content it was given, without removing any', async () => {
    const doctor = createDoctor({ env: PROXY_ENV })
    const result = blockedResult()
    const decision = await doctor.handle(call(), result, async () => ({ kind: 'accept' }))
    assert.equal(decision.kind, 'accept')
    assert.equal(decision.content.length, result.content.length + 1)
    assert.deepEqual(decision.content[0], result.content[0])
    assert.match(decision.content.at(-1).text, /no proxy policy installed/)
  })

  it('appends after content a later policy already replaced', async () => {
    const doctor = createDoctor({ env: PROXY_ENV })
    const replaced = [{ type: 'text', text: 'replaced by a spill policy' }]
    const decision = await doctor.handle(call(), blockedResult(), async () => ({ kind: 'accept', content: replaced }))
    assert.deepEqual(decision.content[0], replaced[0])
    assert.equal(decision.content.length, 2)
  })

  it('leaves a block decision exactly as the policy wrote it', async () => {
    const doctor = createDoctor({ env: PROXY_ENV })
    const feedback = [{ type: 'text', text: 'corrective feedback' }]
    const decision = await doctor.handle(call(), blockedResult(), async () => ({ kind: 'block', feedback }))
    assert.deepEqual(decision, { kind: 'block', feedback })
  })

  it('emits nothing at all when the fetch succeeded', async () => {
    const doctor = createDoctor({ env: PROXY_ENV })
    const decision = await doctor.handle(call(), successResult(), async () => ({ kind: 'accept' }))
    assert.deepEqual(decision, { kind: 'accept' })
    assert.equal(doctor.stats.diagnosed, 0)
  })

  it('never throws when the library misbehaves, and still runs the chain', async () => {
    const doctor = createDoctor({ env: PROXY_ENV })
    const hostile = Object.defineProperty({}, 'name', { get() { throw new Error('boom') } })
    const [counter, next] = countingNext()
    const decision = await doctor.handle(hostile, blockedResult(), next)
    assert.equal(counter.calls, 1)
    assert.deepEqual(decision, { kind: 'accept' })
  })
})
