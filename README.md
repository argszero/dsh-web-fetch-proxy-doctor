# @argszero/dsh-web-fetch-proxy-doctor

Tells you *why* `web_fetch` was blocked, when you set a proxy and it still was.

`web_fetch` refuses a URL whose hostname resolves to a non-public address. That
refusal is raised only on the **direct** branch of the request, after local DNS —
a proxied hop skips both, because the proxy resolves the origin. So
`WEB_BLOCKED_URL` is really a statement about routing: *this request went
direct*. It never says which of three routing states produced that, and nothing
else does either afterwards.

This plugin observes a failed `web_fetch` and appends one block naming the state:

| state | what it means |
|---|---|
| **no proxy policy installed** | the environment names a proxy, but this process has none installed — it was not started by the launcher that installs one, or the plugin resolved a second copy of `@deepseek-ai/dsh-http-proxy` whose module state the launcher never set |
| **bypassed** | a policy is installed, and this URL is exempt from it — the bypass list always carries `localhost`, `127.0.0.1`, `::1`, and always carries every `no_proxy` entry |
| **literal** | a policy is installed and this URL *is* routed through the proxy, yet it was still checked locally — it is an IP literal, and a proxy resolves nothing for an address that is already stated |

## Install

```sh
dsh plugin --profile <name> add github:argszero/dsh-web-fetch-proxy-doctor
```

`npm install` on its own does not mount a plugin: a profile builds its layers
only from the bundles listed in its manifest, and `dsh plugin add` is what writes
that list.

## What you get

The tool result keeps everything it had and gains one block, prefixed with the
plugin's name so the text is attributable:

```
Error: URL hostname "localhost" resolves to a non-public IP address

@argszero/dsh-web-fetch-proxy-doctor: web_fetch was refused by the
public-address check while a proxy policy is active, because "localhost" is
exempt from it: the bypass list always carries localhost, 127.0.0.1 and ::1,
and always carries every no_proxy entry, so this host was treated as local and
resolved here. Set the proxy in the launch environment and restart, or fetch
through a URL the policy does not bypass.
```

Nothing is emitted when the fetch succeeded, and nothing is emitted when no
proxy was named at all — in that case the address check is simply doing its job,
and a warning would be noise. A result another policy already blocked is left
exactly as that policy wrote it.

## What it deliberately does not do

- **No interception.** It never blocks, never turns a success into a failure, and
  never removes content. It runs the rest of the `tools/post-execute` chain first
  and refines the answer.
- **No provider.** It registers no `WebFetchProvider`, so it cannot collide with
  `WEB_PROVIDER_AMBIGUOUS` and asks nobody to edit `web.fetchProvider`.
- **No guessing.** The state comes from the shipped surface only:
  `clearedProxyEnv()` for the names, `proxyEnvironmentForChild()` — which returns
  an empty object exactly when no policy is active — and `proxyRouteFor(url)`.

The one thing it cannot see: if a second copy of `@deepseek-ai/dsh-http-proxy` is
resolved by the plugin rather than by the launcher, the module state it reads is
not the launcher's, and "no policy installed" is reported for a process that has
one. That case is named in the message rather than hidden.

## Verification

```sh
npm test        # unit matrix + wire test through the real registry and provider
npm run smoke   # mount on a real cordis context, then observe the teardown
npm run mutation # 12 defects, each of which the suite must catch
```

The wire test drives the shipped `HttpFetchProvider` with the default resolver
against `localhost`, so the refusal is produced by the shipped code rather than
by a fixture, and it asserts both the silent controls and the mounted diagnostic.

## License

MIT
