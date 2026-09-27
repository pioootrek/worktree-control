---
audience: "self-hosters exposing the dashboard through HTTPS"
last_reviewed: "2026-09-27"
source_of_truth: "supported Caddy reverse-proxy transport for the local controller"
status: "active"
---

# Protect the controller with HTTPS

Worktree Switcher supports one reverse-proxy deployment: Caddy terminates TLS
and forwards to a controller listening only on loopback. The controller keeps
MCP and CLI access local, advertises the configured HTTPS browser origin, and
checks browser `Origin` against that value. It does not trust `Forwarded` or
`X-Forwarded-*` headers.

The examples were validated with Caddy 2.11.3. Use an official Caddy package or
verified release binary. Caddy documents its [installation options][install],
[automatic HTTPS][automatic-https], [local CA][local-https], and
[`reverse_proxy` streaming behavior][reverse-proxy]. Caddy recognizes
`text/event-stream` responses and flushes them immediately; no custom SSE
buffering option is required.

## Required boundaries

- Start Worktree Switcher with `--host 127.0.0.1`. The CLI rejects
  `--public-url` with a non-loopback backend.
- Use a dedicated HTTPS origin at `/`. `--public-url` rejects HTTP,
  credentials, query strings, fragments, and non-root paths.
- Do not expose controller port `47831` through a firewall, port forward, or a
  second proxy. Only Caddy should accept untrusted client connections.
- Keep MCP on its loopback listener. This recipe does not make MCP public.
- Do not disable certificate validation. Every LAN client must trust the
  selected private CA.
- Keep Caddy's data directory persistent and private. It contains certificate
  private keys. Never copy a private CA key to client devices.

## Caddyfile logging guard

The dashboard sends its access token (the installation token, or the pairing
token in `legacy` mode) in the `X-Worktree-Switcher-Token` request header. Caddy's default redaction covers
standard authorization headers, but this product-specific header must be
removed from both runtime diagnostics and access logs. Keep both filters below.
The controller does not accept an access token in an SSE query string.

```caddyfile
{
	log default {
		format filter {
			request>headers>X-Worktree-Switcher-Token delete
		}
	}
}

(switcher_access_log) {
	log {
		output file /var/log/caddy/worktree-switcher-access.log {
			mode 0600
			roll_size 10MiB
			roll_keep 5
			roll_keep_for 168h
		}
		format filter {
			request>headers>X-Worktree-Switcher-Token delete
		}
	}
}
```

Validate the final file before reloading Caddy:

```bash
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

## LAN with Caddy's private CA

Choose a stable private DNS name, make it resolve to the Caddy host from each
allowed device, and add this site block after the logging guard:

```caddyfile
switcher.home.arpa {
	import switcher_access_log
	tls internal
	reverse_proxy 127.0.0.1:47831
}
```

Reload Caddy through its installed service manager. Caddy's unprivileged system
service may be unable to install its root certificate automatically. Follow the
[official local HTTPS instructions][running-local-https] and install only the
root certificate—not its private key—in the trust store of every browser/client
that opens the dashboard. Browsers with separate trust stores may require a
separate import.

For a fresh Switcher service:

```bash
node dist/cli/index.js service install \
  --host 127.0.0.1 \
  --public-url https://switcher.home.arpa
```

Then verify `worktree-switcher service status`, open the address printed by
`worktree-switcher service url` on a device that trusts the CA, and sign in with
the installation token. In `legacy` mode that URL contains the private pairing
token. Never place a token or pairing URL in shared logs or documentation.

## Public domain with an ACME certificate

Point the chosen DNS name at the Caddy host and satisfy Caddy's documented
ACME requirements, including external reachability on the required challenge
and HTTPS ports. Do not use on-demand TLS for this fixed single-domain recipe.

```caddyfile
switcher.example.com {
	import switcher_access_log
	reverse_proxy 127.0.0.1:47831
}
```

Caddy enables HTTPS and certificate renewal for a qualifying public hostname.
Configure Switcher with the same canonical origin:

```bash
node dist/cli/index.js service install \
  --host 127.0.0.1 \
  --public-url https://switcher.example.com
```

Public TLS protects transport; the installation token (or the `legacy` pairing
URL) is still an owner credential.
This setup is not a multi-user account system and does not authorize publishing
the dashboard to arbitrary users.

## Upgrade, certificate replacement, and rollback

First validate and start the proxy. Then explicitly refresh an existing
Switcher service, repeating every non-default option already stored in its
definition:

```bash
node dist/cli/index.js service install --refresh \
  --host 127.0.0.1 \
  --public-url https://switcher.home.arpa \
  --browse-root /home/me/development
```

An invalid public URL or non-loopback bind fails before the service definition
is changed. `--public-url` never edits firewall or Caddy configuration. The
refresh is the explicit operation that changes the controller bind and restarts
the user service; installing this documentation performs neither action.

Caddy manages replacement and renewal for `tls internal` and public ACME
certificates. Validate configuration before reload and confirm the new
certificate with a normal validating client. A wrong hostname, untrusted CA, or
expired certificate must remain an error; never recover by disabling TLS checks.
If Caddy is unavailable, local CLI commands continue through the private access
record even though the public dashboard is unavailable.

Rollback is also explicit: restore the preceding validated Caddy configuration,
then refresh Switcher with the former `--host` and other complete options while
omitting `--public-url`. Do not leave a loopback controller advertised as HTTPS,
or expose its plaintext port as an accidental fallback.

## Acceptance checks

After every initial setup, upgrade, or certificate replacement:

1. `service status` and `project list` work locally even with Caddy stopped.
2. The sign-in page, API mutation, and live updates work through HTTPS.
3. A foreign or `null` browser Origin is rejected.
4. A wrong hostname, missing CA trust, or expired certificate fails visibly.
5. Plain HTTP on the public TLS port does not serve the dashboard.
6. Caddy runtime and access logs do not contain the access token.
7. The MCP endpoint remains loopback-only.

The repository runs the same boundary with a generated fixture CA, a built
controller, Caddy 2.11.3, real TLS, two SSE connections, certificate
replacement, an unavailable backend, an expired certificate, local CLI access,
and Chromium through `pnpm test:https`.

[install]: https://caddyserver.com/docs/install
[automatic-https]: https://caddyserver.com/docs/automatic-https
[local-https]: https://caddyserver.com/docs/automatic-https#local-https
[reverse-proxy]: https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#streaming
[running-local-https]: https://caddyserver.com/docs/running#local-https-with-systemd
