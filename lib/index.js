/**
 * Turn a bare `WEB_BLOCKED_URL` from `web_fetch` into an attributable diagnosis.
 *
 * `web_fetch` refuses a URL whose hostname resolves to a non-public address.
 * That refusal is raised only on the direct branch of the request, after local
 * DNS — a proxied hop skips both, because the proxy resolves the origin. So the
 * error is really a statement about routing: "this request went direct". It just
 * never says which of three routing states produced that, and after the fact
 * nothing else does either. The policy's own diagnostics (`invalid` value, a
 * SOCKS proxy, an unsupported scheme) are written once to stderr at boot, and
 * `WEB_BLOCKED_URL` carries no proxy state at all:
 *
 *   - no proxy policy installed in this process — the launch environment named
 *     one and the install never ran, or never reached this copy of the library;
 *   - a policy is installed and this URL is exempt from it — the bypass list
 *     always carries the loopback entries and always carries `no_proxy`;
 *   - a policy is installed and this URL *is* routed through the proxy, yet the
 *     literal-address rule still checked it locally.
 *
 * This plugin observes a failed `web_fetch` and appends one block naming which
 * state it was, so the user (and the model) can act on it. It observes only: it
 * calls the rest of the `tools/post-execute` chain first, never blocks, never
 * turns a success into a failure, and never removes content. It registers no
 * provider and rewrites no request.
 *
 * The discrimination uses only the shipped surface: `clearedProxyEnv()` for the
 * environment names, `proxyEnvironmentForChild()` — which returns an empty
 * object exactly when no policy is active — and `proxyRouteFor(url)`.
 *
 * @module @argszero/dsh-web-fetch-proxy-doctor
 */

import {
  clearedProxyEnv,
  proxyEnvironmentForChild,
  proxyRouteFor,
} from '@deepseek-ai/dsh-http-proxy'

/** Plugin name reported by the loader, and the prefix of every message it emits. */
export const name = '@argszero/dsh-web-fetch-proxy-doctor'

/**
 * No service is required: the plugin only listens, and an absent `tools`
 * registry simply means no `web_fetch` call will ever be dispatched. Injecting
 * one would make the plugin pending in a composition that has no tools, where it
 * has nothing to observe anyway.
 */
export const inject = []

/** The tool whose failure this plugin explains. */
export const TOOL = 'web_fetch'

/** The error code raised when the public-address check refuses a URL. */
export const CODE = 'WEB_BLOCKED_URL'

/**
 * The proxy names that only exempt destinations, so they never ask for a proxy.
 * `no_proxy` configures the bypass list, not a transport: a user who exports it
 * alone has not asked for anything to be proxied, and reporting that they had
 * would be a false positive on every internal-address rejection.
 */
const BYPASS_ONLY_NAMES = new Set(['no_proxy'])

/**
 * Read the proxy names the launch environment actually set.
 *
 * The names are taken from `clearedProxyEnv()`, whose keys are exactly the names
 * this harness's proxy layer owns in both casings — reading them here rather than
 * restating a list is what keeps the two from drifting apart.
 *
 * @param env - environment to read; `process.env` in ordinary use.
 * @returns the names that carry a non-empty value and name a proxy.
 */
export function proxyNamesInEnvironment(env = process.env) {
  const names = []
  for (const key of Object.keys(clearedProxyEnv())) {
    if (BYPASS_ONLY_NAMES.has(key.toLowerCase())) continue
    const value = env?.[key]
    if (typeof value === 'string' && value !== '') names.push(key)
  }
  return names
}

/**
 * Whether an installed proxy policy exists in this process.
 *
 * `proxyEnvironmentForChild()` answers the question the diagnosis needs: it
 * returns an empty object when no policy is active — absent, deliberately
 * direct, or never installed — and the resolved names otherwise.
 *
 * @returns whether a policy is installed in the library this plugin resolved.
 */
export function hasInstalledPolicy() {
  try {
    return Object.keys(proxyEnvironmentForChild()).length > 0
  } catch {
    // A probe must never decide whether the tool result stands.
    return false
  }
}

/**
 * Parse the URL a `web_fetch` call named.
 * @param exec - the execution the listener received.
 * @returns the parsed URL, or `undefined` when the arguments carry none.
 */
export function requestedUrl(exec) {
  const raw = exec?.arguments?.url
  if (typeof raw !== 'string') return undefined
  try {
    return new URL(raw)
  } catch {
    return undefined
  }
}

/**
 * Decide whether this failure is one the plugin can explain, and if so which
 * routing state produced it.
 *
 * @param exec - the execution the listener received.
 * @param result - the dispatch outcome, before the rest of the chain refines it.
 * @param env - environment to read; `process.env` in ordinary use.
 * @returns the diagnosis, or `undefined` when there is nothing to say.
 */
export function diagnose(exec, result, env = process.env) {
  if (exec?.name !== TOOL) return undefined
  if (result?.isError !== true) return undefined
  if (result?.error?.info?.code !== CODE) return undefined

  const url = requestedUrl(exec)
  if (url === undefined) return undefined

  // Nothing was asked of the proxy, so the refusal is the guard doing its job.
  // Explaining it would be noise on every ordinary internal-address rejection.
  const named = proxyNamesInEnvironment(env)
  if (named.length === 0) return undefined

  if (!hasInstalledPolicy()) {
    return { state: 'no-policy', hostname: url.hostname, named, url: url.toString() }
  }

  const proxied = (() => {
    try {
      return proxyRouteFor(url).proxied
    } catch {
      return undefined
    }
  })()
  if (proxied === undefined) return undefined
  return { state: proxied ? 'literal' : 'bypassed', hostname: url.hostname, named, url: url.toString() }
}

/**
 * Render one diagnosis as the block appended to the tool result.
 * @param diagnosis - the outcome of {@link diagnose}.
 * @returns the text the user and the model both see.
 */
export function messageFor(diagnosis) {
  const where = `${name}: web_fetch was refused by the public-address check `
  const hint = ' Set the proxy in the launch environment and restart, or fetch through a URL the policy does not bypass.'

  if (diagnosis.state === 'no-policy') {
    return where
      + `for "${diagnosis.hostname}" and this process has no proxy policy installed (the environment names ${diagnosis.named.join(', ')}), `
      + 'so it resolved the hostname locally. A launched profile installs the policy before the first plugin mounts, '
      + 'so seeing none here means either this process was not started by that launcher — a child, a test, an embedded '
      + 'runtime — or this plugin resolved a second copy of @deepseek-ai/dsh-http-proxy, whose module state the '
      + 'launcher never set.'
  }
  if (diagnosis.state === 'bypassed') {
    return where
      + `while a proxy policy is active, because "${diagnosis.hostname}" is exempt from it: the bypass list always `
      + 'carries localhost, 127.0.0.1 and ::1, and always carries every no_proxy entry, so this host was treated as '
      + 'local and resolved here.'
      + hint
  }
  return where
    + `even though the proxy policy routes this URL through the proxy: "${diagnosis.hostname}" is an IP literal, and `
    + 'a literal is always checked here because a proxy resolves nothing for an address that is already stated.'
    + ' Fetch a hostname instead.'
}

/**
 * Append the warning to a decision the rest of the chain produced.
 * A `block` decision carries another policy's corrective feedback and is left
 * exactly as that policy wrote it.
 * @param decision - what `next()` returned.
 * @param original - the result the chain was given.
 * @param diagnosis - the outcome of {@link diagnose}.
 * @returns the decision to return upward.
 */
function withWarning(decision, original, diagnosis) {
  if (decision?.kind !== 'accept') return decision
  const base = Array.isArray(decision.content) ? decision.content : original?.content
  if (!Array.isArray(base)) return decision
  return { ...decision, content: [...base, { type: 'text', text: messageFor(diagnosis) }] }
}

/**
 * Create the observer used by one plugin instance.
 * @param options - logger and environment, both optional.
 * @returns the handler, plus the counters a test or an operator can read.
 */
export function createDoctor(options = {}) {
  const { logger, env = process.env } = options
  const reported = new Set()
  const stats = { observed: 0, diagnosed: 0 }

  function handle(exec, result, next) {
    let diagnosis
    try {
      diagnosis = diagnose(exec, result, env)
    } catch {
      // Deciding nothing is always safe; throwing here would turn a reported
      // tool failure into an unreported one.
      diagnosis = undefined
    }
    if (diagnosis === undefined) return next()
    stats.observed += 1
    return Promise.resolve(next()).then((decision) => {
      const refined = withWarning(decision, result, diagnosis)
      if (refined !== decision) stats.diagnosed += 1
      report(logger, reported, diagnosis)
      return refined
    })
  }

  return { handle, stats }
}

/**
 * Write the same diagnosis to the logger once per state and host.
 * The tool result is the user-visible channel; this one is for operators
 * reading a log, so it is deduplicated.
 * @param logger - cordis logger, when the composition supplied one.
 * @param reported - the set that deduplicates across calls.
 * @param diagnosis - the outcome of {@link diagnose}.
 */
function report(logger, reported, diagnosis) {
  if (typeof logger?.warn !== 'function') return
  const key = `${diagnosis.state}\u0000${diagnosis.hostname}`
  if (reported.has(key)) return
  reported.add(key)
  logger.warn(messageFor(diagnosis))
}

/**
 * Mount the observer on one context.
 * Registered at the default position rather than prepended: the appended text
 * belongs after every policy that may replace the content, so it describes what
 * the user will actually read.
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  const doctor = createDoctor({ logger: ctx.logger })
  ctx.on('tools/post-execute', (exec, result, next) => doctor.handle(exec, result, next))
}

export default { name, inject, apply }
