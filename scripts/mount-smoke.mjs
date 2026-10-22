/**
 * Mount smoke: the plugin as the loader mounts it, on a real cordis context,
 * with the real tool registry and the real fetch provider beside it. Nothing
 * here re-implements the plugin's own logic — it answers whether a composition
 * that installs this package observes a blocked fetch, and whether its teardown
 * really removes the observation.
 */
import assert from 'node:assert/strict'

import { Context } from '@deepseek-ai/cordis'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http'

import doctor from '../lib/index.js'

const PROXY_ENV = { http_proxy: 'http://127.0.0.1:7897', https_proxy: 'http://127.0.0.1:7897' }
const lookup = (env) => ({ get: (name) => (env[name] === undefined ? undefined : { value: env[name] }) })
const signal = new AbortController().signal

const disposeProxy = await installProxyFromEnvironment(lookup(PROXY_ENV), (line) => console.log(`policy: ${line}`))
const provider = new HttpFetchProvider({
  maxResponseBytes: 5_000_000,
  maxBodyChars: 100_000,
  timeoutMs: 5_000,
  maxRedirects: 5,
  userAgent: 'dsh-web-fetch-proxy-doctor/smoke',
})

const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
const fiber = await ctx.plugin(doctor)

ctx.tools.register(defineTool({
  name: 'web_fetch',
  description: 'The shipped provider, unmodified.',
  parameters: { url: { type: 'string', required: true } },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: () => [{ type: 'text', text: 'ok' }],
  },
  async execute(args, exec) {
    return await provider.fetch({ url: args.url }, exec.signal)
  },
}))

const run = async () => await ctx.tools.execute({
  signal, callId: 'smoke', name: 'web_fetch', arguments: { url: 'https://localhost/' },
})

const mounted = await run()
assert.equal(mounted.isError, true, 'the shipped provider must refuse a non-public address')
assert.equal(mounted.error?.info?.code, 'WEB_BLOCKED_URL')
assert.equal(mounted.content.length, 2, 'the shipped text plus exactly one diagnostic')
assert.ok(
  mounted.content.at(-1).text.startsWith('@argszero/dsh-web-fetch-proxy-doctor:'),
  `the mounted plugin must append its diagnosis, got: ${JSON.stringify(mounted.content)}`,
)
console.log(`mounted: appended 1 diagnostic — ${mounted.content.at(-1).text.slice(0, 96)}…`)

await fiber.dispose()
const afterDispose = await run()
assert.equal(afterDispose.isError, true, 'the fetch still fails after teardown')
assert.equal(afterDispose.content.length, 1, 'a disposed plugin must append nothing')
console.log('disposed: appended 0 diagnostic blocks')

await ctx.fiber.dispose()
await disposeProxy()
console.log('smoke ok')
