# Provisioning a VPS as a Coxia instance

A fresh Ubuntu 24.04 VPS becomes a Coxia instance through versioned code: cloud-init, one script and a client that drives them over SSH. An agent may decide and propose; this code is what runs, and nobody gets a free root shell on the machine.

## What runs where

| Piece | Where | Does |
|---|---|---|
| [`src/cloudInit.ts`](../src/cloudInit.ts) `renderCloudInit()` | the old instance, pure | renders the cloud-config user-data from typed input |
| cloud-init | the new machine, first boot | creates the admin user and installs the key, hardens sshd, writes the settings file and the script, runs `coxia-provision provision` |
| [`deploy/provision.sh`](../deploy/provision.sh) | the new machine, as root, at `/usr/local/sbin/coxia-provision` | firewall, unattended upgrades, swap, coxia-server at its ref plus its `install.sh`, checks, host keys, the recovery copy |
| [`src/provision.ts`](../src/provision.ts) `provisionMachine()` | the old instance | waits for cloud-init, re-runs the script, reads the host keys, checks health, fetches the recovery copy; over an `SshRunner` port |
| coxia-server `deploy/install.sh` | the new machine, called by provision.sh | Node with its checksum, bubblewrap, the AppArmor profile, the `coxia` user, the build, the voice sidecar, the systemd unit, the master key |

provision.sh does not copy install.sh. It fetches coxia-server at the pinned ref into `/opt/coxia-provision/coxia-server` (detached, cleaned, a full commit id is checked against what git resolved) and runs `./deploy/install.sh` from there, passing `COXIA_REF`, `COXIA_VOICE_MODEL` and `NODE_SHA256` when set.

## The input

`CloudInitInput`: the admin public key(s), the coxia-server ref, the contents of `deploy/provision.sh` at that same commit, the timezone, an optional swap size in MB, and optionally the admin user (default `admin`), the coxia-server repository URL and the Coxia release (`COXIA_REF`). Every value is validated to a narrow shape before it reaches YAML, a git command line or a shell word, and values are written as JSON strings so none can break out of its line. **Pin the server ref to a full commit id**: a tag or branch is only as fixed as the remote keeps it.

The script travels inside the user-data (`write_files`, `gz+b64`), so nothing is fetched to start and no private repository has to be reachable for that. The server checkout still comes from `serverRepoUrl`; while coxia-server is private that URL needs credentials or a different delivery (an open decision, see below).

## Decisions

- **Root login off, a sudo user instead.** `PermitRootLogin no`, `AllowUsers <admin>`, password and keyboard-interactive off, `AuthenticationMethods publickey`. The admin account has a locked password and `NOPASSWD` sudo, so the key is the one credential, as it would be for root. The gain over "root by key": nothing probes the `root` name, `sudo` leaves an audit line per elevation in the journal, and a command such as `coxia-server status` runs as the `coxia` user through `sudo -u` rather than as root. The cost, stated plainly: whoever holds the key has root. The key is the person's and stays on their computer.
- **Firewall.** ufw: deny incoming, allow outgoing, allow 22/tcp. The supervisor binds the cores to 127.0.0.1 and provision.sh fails if anything else listens beyond loopback and port 22. Port 22 only: provision.sh refuses to continue if `sshd -T` reports another port, so enabling ufw cannot cut the session. Admin clients reach the web client through `ssh -L`; `AllowTcpForwarding` is left at its default for that.
- **Unattended upgrades on, automatic reboot off.** Security updates install by themselves; a reboot at an hour nobody chose would cut running agents, so `/var/run/reboot-required` is the cue for the person.
- **Idempotent.** Each step converges: files are rewritten only when different, ufw rules and apt packages are no-ops the second time, the swap file is recreated only when its size differs, the checkout is forced to the ref, and install.sh never regenerates the master key or touches the data folder. A second run does restart the service (install.sh does) and rebuilds nothing already built.
- **The "SSH key the clients use".** Read as the machine's SSH host key: `ssh-keygen -A` makes sure it exists and the script reports its SHA256 fingerprints (`coxia-provision host-keys`, `HostKeyFingerprint[]` in the result) so the desktop can trust the machine by comparison. A key pair for logging in is made on the person's side and only its public half is given as input; a private key made on the machine would have to leave it. Fingerprints read over the first SSH connection are trust on first use; if the provider shows the host key in its console output, compare with that.

## Threat notes

**User-data is not secret.** Providers keep it readable through their metadata API (from inside the machine, on some providers without authentication) for the life of the machine. It holds public keys, a ref, a timezone, a swap size and the script. Rendering refuses a private key and a test checks that the output has no 64-digit hex string. Never add a token, a password or the master key.

**Master key.** `install.sh` creates it once at `/etc/coxia/master.key` (64 hex digits, 0600, owned by `coxia`, outside the data folder; the core refuses a key inside it). provision.sh only checks existence, mode and format after install.sh, and stops if they are wrong: generating a second key would orphan every stored secret. The key is never in user-data, in an environment variable or in a log.

**Recovery copy, once.** `coxia-provision recovery-copy` (root, reached with `sudo -n` over the SSH session the client already holds):

1. if the marker `/var/lib/coxia-provision/recovery-copy-handed-over` exists, it exits 3 and prints nothing on stdout;
2. it validates the key file (exit 4 if missing or malformed, with no marker);
3. it creates the marker atomically (`noclobber`, mode 0600, holding a timestamp and the sudo user, never the key), then prints the key alone on stdout.

The marker comes before the key so a broken transfer cannot offer the key twice; the price is that a lost transfer is lost. The key is still in `master.key` for root, and deleting the marker is a deliberate manual act. `provisionMachine()` asks for it last, after the health check, so a failed provision does not burn the single handover; the result carries it in memory (`recoveryCopy`) and writes nothing to disk. The `SshRunner` is told the call is `sensitive` and must not log its output. On a machine that already handed it over, the result has `recoveryCopyStatus: 'already-handed-over'` and no key; `fetchRecoveryCopy()` called directly throws `RecoveryCopyRefusedError`. The caller must put the key in the person's hands (a password manager, a one-time screen) and not in a log or a file. Honest limit: any holder of the admin key can run `sudo cat` on the file; the marker makes the protocol once-only, not the key unreadable to root.

## Tests

`node --test "test/*.test.ts"`, no network and no machine: cloud-init rendering (header, pinned ref, no secret, the embedded script equals provision.sh, the sshd lines agree with the script, bad input refused), `provisionMachine` against a fake `SshRunner` (order, retries, errors, once-only recovery copy), and provision.sh in its sandbox mode, where `COXIA_PROVISION_SANDBOX=1` points `host-keys` and `recovery-copy` at a throwaway folder and `provision` refuses to run. `shellcheck deploy/provision.sh` runs in CI.

## Not verified on a real VPS

Nothing here ran on a real machine or against a real provider. Not verified: the full `provision` run (apt, sshd drop-in precedence and `sshd -T` checks on 24.04 with the provider's own `50-cloud-init.conf`, ufw activation, swap on the provider's file system, the `ss` listener check), cloud-init accepting the rendered file (including `gz+b64` and the `users` block replacing the default user), the checkout fetching a commit id from the server repository, coxia-server's `install.sh` end to end, and a real SSH runner (this repository defines the port and the fake; an adapter around `ssh` is the caller's). Open: how coxia-server is delivered while its repository is private, and whether the desktop should compare fingerprints with a provider-reported one.
