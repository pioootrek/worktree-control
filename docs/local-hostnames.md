---
audience: "people who want a readable local address for each managed project"
last_reviewed: "2026-10-08"
source_of_truth: "optional reverse-proxy recipe built on stable per-project ports"
status: "active"
---

# Stable local hostnames

Every Worktree Control project keeps one configured port, whichever worktree
is running. A reverse proxy can add a readable name on top of that port, such
as `http://frontend.localhost`, so you do not memorize numbers.

Worktree Control does not install, configure or start this proxy, and it never
reads the proxy's configuration. The recipe stays outside the supervised
repositories: nothing is added to a project, and switching worktrees does not
change the address.

## Caddyfile

The README example runs a frontend on port 3000 and an API on port 4000. Map a
name to each port:

```caddyfile
http://frontend.localhost {
	bind 127.0.0.1
	reverse_proxy localhost:3000
}

http://api.localhost {
	bind 127.0.0.1
	reverse_proxy localhost:4000
}
```

Use the port assigned to the project in Worktree Control. The upstream is
`localhost`, not `127.0.0.1`, so Caddy tries both IPv4 and IPv6 loopback; a dev
server that listens on only one family still works. `bind 127.0.0.1` keeps the
proxy off your network. The `http://` prefix keeps Caddy from
issuing a certificate for the name. Port 80 is privileged on many systems;
append a port such as `http://frontend.localhost:8080` to the site address if
Caddy cannot bind it, and open `http://frontend.localhost:8080`.
Validate the file before reloading Caddy:

```bash
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

This snippet was not run against Caddy on the host where it was written. For
HTTPS to the controller dashboard itself, see
[Protect the controller with HTTPS](controller-https.md); that is a separate
setup.

## Name resolution

The `localhost` top-level name is reserved for loopback by
[RFC 6761](https://www.rfc-editor.org/rfc/rfc6761#section-6.3), so no
`/etc/hosts` entry is needed where the resolver follows it:

- `systemd-resolved` resolves any name ending in `.localhost` to loopback,
  as its manual page documents. On the Linux host where this page was
  written, `getent ahosts frontend.localhost` returned both `::1` and
  `127.0.0.1`. (`getent hosts` prints only the first address, `::1`.)
- Chrome and Firefox treat `*.localhost` as loopback themselves. Check the
  behavior of your browser version if a name does not open.
- macOS: verify on your host. Browsers may accept `*.localhost`, but command-line
  tools and other applications may need a resolver configuration or an
  `/etc/hosts` line such as `127.0.0.1 frontend.localhost`.

A name can resolve to `::1`, `127.0.0.1` or both, and a dev server may listen
on only one of them (for example Vite bound to `localhost` on a host that
resolves it to IPv6 first). Worktree Control's readiness check accepts the port
on any local address, so the dashboard can show the project running while a
proxy upstream pinned to one family returns 502. That is why the Caddyfile uses
`localhost:<port>` as the upstream.

## Limits

- A dev server may reject requests whose `Host` header it does not recognize.
  Vite, Next.js and others have such settings and their defaults change between
  versions. If a proxied name returns an error, check the framework's allowed
  hosts or dev-origin option; this page does not verify them.
- A project with the Next.js development HTTPS setting is started with
  `--experimental-https`, so its port serves TLS and a plain `reverse_proxy`
  fails. Use an `https://` upstream with a transport block, or turn the
  development HTTPS setting off while you use this proxy:

  ```caddyfile
  reverse_proxy https://localhost:3000 {
    transport http {
      tls_insecure_skip_verify
    }
  }
  ```

  `tls_insecure_skip_verify` disables certificate checks for that upstream; with
  a custom certificate, trust its CA in Caddy instead.
- The proxy keeps working while a project is stopped and returns a bad-gateway
  response from Caddy until the server starts again.
- Without `bind 127.0.0.1`, Caddy listens on all interfaces. Worktree Control's
  authentication does not protect the proxied applications, so omit it only if
  you intend to expose development servers to your network.
