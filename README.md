# Coxia Provision

How a Coxia instance moves to a VPS on its own: a provider interface for buying and managing the machine within a budget, cloud-init and the provisioning script, the handover of a workspace from one instance to another, snapshots before each update, rollback when the health check fails, and the external uptime monitor.

## Install on a fresh VPS

On any fresh Ubuntu 24.04 server, as root or through `sudo`:

```bash
curl -fsSL https://raw.githubusercontent.com/exatasmente/coxia-provision/<tag>/install.sh \
  | sudo bash -s -- --server-ref <coxia-server tag or commit> --admin-key "$(cat ~/.ssh/id_ed25519.pub)"
```

Use a release tag for `<tag>` (see [RELEASING.md](RELEASING.md)), not `main`. When the script is the
copy published under a tag it fetches that same tag; from anywhere else it falls back to `main` and warns.
Both repositories are fetched anonymously over https; no credential is asked for or kept.

**What it does.** It refuses unless it runs as root on Ubuntu 24.04, fetches coxia-provision at `--ref`
into `/opt/coxia-provision/<ref>`, writes `/etc/coxia-provision.env` (settings only, no secret) and the
admin keys, installs `coxia-provision` into `/usr/local/sbin`, and runs `coxia-provision provision`:
the admin user with your key, sshd lockdown (no root login, no passwords), a firewall that only lets
port 22 in, unattended security upgrades, optional swap and timezone, then coxia-server at its ref and
its own `install.sh`. A second run converges and changes nothing. The steps are in
[docs/provisioning.md](docs/provisioning.md).

| Option | Meaning |
|---|---|
| `--ref <ref>` | coxia-provision tag, branch or commit. Default: the tag the file was published under |
| `--server-ref <ref>` | coxia-server ref; a full commit id is the most fixed choice |
| `--coxia-ref <tag>` | public Coxia core tag the server builds |
| `--admin-user <name>` | sudo user that holds the key (default `admin`) |
| `--admin-key "<key>"` | ssh public key, repeatable. Required unless the admin user already has one: hardening leaves the key as the only way in, so without one the script refuses before touching sshd |
| `--no-harden` | skip the sshd lockdown and the firewall, for machines you manage yourself (prints a loud warning) |
| `--swap <size>` | swap file such as `2G` or `512M` |
| `--timezone <tz>` | IANA name such as `Etc/UTC` |
| `--force-os` | run on something other than Ubuntu 24.04 |
| `--yes` | do not ask for confirmation (needed when there is no terminal) |

**What it prints at the end:** the SSH host key fingerprints (compare them with what `ssh` showed on
your first connection), how to pair a device (`coxia-server pair [workspace]`, run as the admin user),
and how to take the one recovery copy of the master key: `sudo coxia-provision recovery-copy`. That
copy works **once**; run it in your own terminal and put the output in a password manager. The key
itself is never printed unasked.

After the install, root cannot log in over ssh any more: use `ssh <admin-user>@<host>`.

A provider's post-install hook or cloud-init can run the same steps without `curl | bash`:
`renderPostInstallScript()` in [`src/bootstrap.ts`](src/bootstrap.ts) and `renderCloudInit()` in
[`src/cloudInit.ts`](src/cloudInit.ts) embed `deploy/provision.sh` and write the same settings.

## Move a running Coxia to a VPS

`coxia-provision move` buys a VPS within the budget (the purchase waits for your yes), provisions it, moves one workspace there with its secrets re-encrypted under the VPS key, checks it and prints what the desktop needs; any failure leaves the local instance the owner. See [docs/move.md](docs/move.md).

## Status

Public, working towards the Coxia 1.0 release; the one-line install fetches this repository anonymously.
Until a release tag exists, point `--ref` at a branch and expect the "not pinned" warning. The repository
carries no company, person, host, real issue number or secret in code, tests, docs, commit messages or
branch names: `node scripts/public-audit.mjs` enforces that in CI. The script is a copy of the one in the
Coxia repository; keep them in sync.

## How it fits

The Coxia core and its client contract live in the public repository
[exatasmente/coxia](https://github.com/exatasmente/coxia). This repository depends
on them; the public repository never depends on this one.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
