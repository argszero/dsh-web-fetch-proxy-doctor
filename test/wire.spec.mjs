/**
 * Wire evidence: the real tool registry, the real fetch provider, and the real
 * proxy policy — no fixture stands in for any of them.
 *
 * The shipped `HttpFetchProvider` performs the check itself: with the default
 * resolver it resolves `localhost` to 127.0.0.1, and `network.ts` refuses it
 * with `WEB_BLOCKED_URL` before any socket opens. That error travels through the
 * registry's own `toolErrorResult`, arrives at `tools/post-execute`, and the
 * plugin's block is what the caller finally reads.
 */
import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http'

import doctor from '../lib/index.js'

/** Environment naming a local proxy, as a user would export it. */
const PROXY_ENV = {
  http_proxy: 'http://127.0.0.1:7897',
  https_proxy: 'http://127.0.0.1:7897',
  no_proxy: 'localhost,127.0.0.1',
}

const LIMITS = {
  maxResponseBytes: 5_000_000,
  maxBodyChars: 100_000,
  timeoutMs: 5_000,
  maxRedirects: 5,
  userAgent: 'dsh-web-fetch-proxy-doctor/test',
}

/** The `EnvLookup` shape the shipped install expects. */
function lookup(env) {
  return { get: (name) => (env[name] === undefined ? undefined : { value: env[name] }) }
}

const signal = new AbortController().signal
const cleanups = []
after(async () => { for (const fn of cleanups.splice(0)) await fn() })

/**
 * Mount the registry with the plugin, and register the shipped provider's real
 * fetch behind a tool named `web_fetch`.
 */
async function mount() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(doctor)
  const provider = new HttpFetchProvider(LIMITS)
  ctx.tools.register(defineTool({
    name: 'web_fetch',
    description: 'Fetch one HTTP(S) URL — the shipped provider, unmodified.',
    parameters: { url: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: () => [{ type: 'text', text: 'ok' }],
    },
    async execute(args, exec) {
      return await provider.fetch({ url: args.url }, exec.signal)
    },
  }))
  cleanups.push(() => ctx.fiber.dispose())
  return ctx
}

/** Run one web_fetch call through the mounted registry. */
async function fetchThrough(ctx, url) {
  return await ctx.tools.execute({
    signal, callId: `wire-${url}`, name: 'web_fetch', arguments: { url },
  })
}

describe('the real provider', () => {
  it('raises WEB_BLOCKED_URL through the registry with nothing installed', async () => {
    const ctx = await mount()
    const result = await fetchThrough(ctx, 'https://localhost/')
    assert.equal(result.isError, true)
    assert.equal(result.error?.info?.code, 'WEB_BLOCKED_URL')
    assert.equal(result.error?.info?.name, 'WebError')
    // No proxy was named in this process, so the plugin stayed silent: the text
    // is exactly what the shipped registry produced.
    assert.equal(result.content.length, 1)
    assert.match(result.content[0].text, /resolves to a non-public IP address/)
  })

  it('names the bypass state when a real policy is installed', async () => {
    const dispose = await installProxyFromEnvironment(lookup(PROXY_ENV), () => {})
    cleanups.push(dispose)
    const ctx = await mount()

    const result = await fetchThrough(ctx, 'https://localhost/')
    assert.equal(result.isError, true)
    assert.equal(result.error?.info?.code, 'WEB_BLOCKED_URL')
    assert.equal(result.content.length, 2, 'the shipped text plus exactly one diagnostic')

    const diagnostic = result.content.at(-1).text
    assert.ok(diagnostic.startsWith('@argszero/dsh-web-fetch-proxy-doctor:'), diagnostic)
    assert.match(diagnostic, /while a proxy policy is active/)
    assert.match(diagnostic, /localhost/)
  })

  it('emits nothing for a successful fetch', async () => {
    const dispose = await installProxyFromEnvironment(lookup(PROXY_ENV), () => {})
    cleanups.push(dispose)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(doctor)
    ctx.tools.register(defineTool({
      name: 'web_fetch',
      description: 'A successful fetch.',
      parameters: { url: { type: 'string', required: true } },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: () => [{ type: 'text', text: 'page' }],
      },
      async execute() {
        return { url: 'https://example.com/', statusCode: 200 }
      },
    }))
    cleanups.push(() => ctx.fiber.dispose())

    const result = await fetchThrough(ctx, 'https://example.com/')
    assert.equal(result.isError, false)
    assert.equal(result.content.length, 1)
    assert.match(result.content[0].text, /^page$/)
  })
})

describe('the plugin in a composition', () => {
  it('stops observing once its fiber is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(doctor)
    let seen = 0
    ctx.on('tools/post-execute', async (_exec, _result, next) => { seen += 1; return next() })
    ctx.tools.register(defineTool({
      name: 'web_fetch',
      description: 'Always fails with the blocked code.',
      parameters: { url: { type: 'string', required: true } },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: () => [{ type: 'text', text: 'x' }],
      },
      async execute() {
        const error = new Error('URL hostname "x" resolves to a non-public IP address')
        error.name = 'WebError'
        throw error
      },
    }))
    cleanups.push(() => ctx.fiber.dispose())

    await fetchThrough(ctx, 'https://a.example/')
    const before = seen
    await fiber.dispose()
    const result = await fetchThrough(ctx, 'https://b.example/')
    assert.equal(seen, before + 1, 'the unrelated listener still runs after the plugin is gone')
    assert.equal(result.content.length, 1, 'a disposed plugin appends nothing')
  })
})
