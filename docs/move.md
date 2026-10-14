# Moving a running Coxia to a VPS it buys

`coxia-provision move` takes one workspace from the Coxia running on this computer to a VPS bought for it. Three pieces take part: this CLI (on the person's computer), the Coxia core (the desktop or a headless process on this computer, reached over its local admin door) and coxia-server (on the VPS). The names and formats that cross between them are fixed in the contract of the three repositories; this page is the part that is this repository's.

```bash
coxia-provision move --provider hostinger --plan <plan id> --region <data center id> --server-ref <coxia-server commit> \
  --admin-socket <data dir>/workspaces/<id>/admin.sock --token-file ~/hostinger.token --recovery-copy-file ~/vps-master.key
```

| Option | Meaning |
|---|---|
| `--provider`, `--plan`, `--region` | what to buy; `hostinger` is the only adapter |
| `--server-ref` | the coxia-server ref to install (a full commit id is the most fixed choice); `--coxia-ref`, `--image` (default `Ubuntu 24.04`), `--timezone`, `--admin-user` as in [provisioning](provisioning.md) |
| `--token-file` | the provider token, a regular file readable by you only (0600); else the `HOSTINGER_API_TOKEN` variable. Read through a `SecretResolver`, never kept, never in a message |
| `--admin-socket` | the core's admin door (or `COXIA_ADMIN_SOCKET`). The desktop opens it only when you switch it on in its own settings |
| `--recovery-copy-file` | where the VPS master key is written (0600, must not exist). Without it the key is shown once on the terminal |
| `--yes-deploy-key` | do not ask whether the VPS's deploy key was added to your repositories |
| `--destroy-on-failure` | on failure end the machine through the guarded destroy. Default: keep it |
| `--resume <id>` / `--abort <id>` | continue a move from its first unfinished step, or give the workspace back after a crash |

## The steps

Every step is journaled and safe to run again.

1. **propose.** Checks that this instance owns the workspace (`ownership:status`, role `owner`), reads the price of the plan (`priceOf`) and prints it. The purchase itself waits for the core's spend gate in the next step: the budget, then a grant, then **your yes** in the desktop's Actions. The first purchase is never automatic.
2. **keys.** An ed25519 pair for the admin user, made with `ssh-keygen` in the move's folder (0600). Only the public half goes to the provider.
3. **buy.** `createServer` on the guarded provider (`accounts:assert`, `effects:request`/`effects:settle`, audit, redaction). The bootstrap is the post-install script (Hostinger) or cloud-init, with the admin key. A purchase refused by the gate stops here with nothing bought. A Hostinger purchase waiting for payment is waited for, then reported; finish it in the panel and resume.
4. **provision.** Waits for the machine and runs `provisionMachine` over ssh without asking for the recovery copy, then verifies the host keys (below).
5. **deploy-key.** `sudo -n coxia-server deploy-key` on the VPS creates (once, never overwritten) the ssh key the `coxia` user clones with, and prints its public line; anything that is not one `ssh-ed25519 ...` line is refused. The key is journaled (it is public), so a resume shows it again without running anything. If a repository of the workspace has an ssh remote (read with `config:get` on the admin door; if the config cannot be read, the move asks anyway), the CLI shows the key and the remotes and asks: **add it as a deploy key with write access on each repository, then answer yes**. A no (or no terminal) ends the move as `failed` here, before the step-down, so nothing is rolled back and the VPS is kept; resume once the key is added. `--yes-deploy-key` skips the question for scripted runs. It comes before the recovery copy so that waiting on you never spends the single handover.
6. **recovery-copy.** The VPS master key, once (`recovery-copy` of [provisioning](provisioning.md)), held in memory. It is the key the exported secrets are encrypted under.
7. **step-down.** `ownership:move-out` with `to: vps:<provider>:<server id>`. From here the local instance is a client for good.
8. **export.** `move:export` with the recovery copy as `targetKey` and a new folder in the move's folder as `out`; the bundle is tarred (`bundle.tar.gz`, the folder's contents at the top level).
9. **copy-handover.** The recovery copy goes to the person, once: already in the `--recovery-copy-file`, or printed with a warning. If this run no longer holds it (a resume), the step is `skipped` and the summary says where it still is.
10. **transfer.** `scp` of the tarball to `/home/<admin>/coxia-move-<id>.tar.gz`.
11. **import.** `ssh ... sudo -n coxia-server import <tarball>`: clones, git identity, the core's `--import`, restart, health. The result line must name the workspace with `health: ok`. The tarball is deleted on the VPS whatever happened.
12. **health.** `coxia-server status` and `coxia-server call <workspace> ownership:status` on the VPS: the role must be `owner`. That is the handover of ownership: the VPS acquires the workspace because the exported folder carries no lease.
13. **finish.** The bundle and the tarball are removed from this computer. The CLI prints what the desktop's Instances screen needs: the ssh target, the workspace, the key file, the move's known_hosts file and the host key fingerprints (compare them with the provider's console), and the secrets that were not moved.

## When something fails

- **The local instance stays the owner.** A failure before the step-down leaves it untouched. A failure at or after it (including a step-down whose answer was lost) ends with `ownership:claim` `{admin: true}` on the admin door, over a connection that is reopened if it dropped. `claim` is called only if `move-out` ran or may have run: a refused `move-out` (`not-owner`) did not move anything, and a claim after it would be noise.
- **A failed import stops coxia on the VPS first** (`systemctl stop coxia`, best effort), because the imported copy would start as owner on its own: two owners must never run. If that fails the journal and the message say so.
- **The VPS is kept** for a retry by default. `--destroy-on-failure` ends it through `destroyServer` of the guarded provider, which asks the destroy guard (`effects:request` with kind `destroy`: a grant that covers it, or the passkey). Hostinger can only turn off the renewal: the machine runs and is billed until the end of its term, and the audit says so. A refused destroy leaves the machine, still gives the workspace back, and the report says the machine is kept.
- **Resume.** `--resume <id>` runs from the first unfinished step. After a rollback the steps from the step-down on are marked `rolled-back` and run again (the core accepts `move:export` only on a moved-out workspace). Nothing bought is bought again: a purchase whose outcome is unknown (a timeout after the order) is looked up by its hostname `coxia-<id>` and adopted, and when it is not listed the move stops and asks you to look in the provider's panel.
- **A crash** can leave the local instance moved out. `coxia-provision move --abort <id> --admin-socket ...` gives the workspace back (and, with the flag, ends the machine).

### The recovery copy and a resume

The VPS hands its master key out **once**. The key is held in memory only: it is passed to `move:export` and handed to the person, never written to the journal, the audit log or any message (every line the move prints, and every journal detail, is scrubbed of it, and the journal writer refuses to write it). Therefore:

- With `--recovery-copy-file` the key is written there as soon as it is read, so a resume can read it back (the file must not exist when the move starts, so an old key is never taken for the new machine's).
- Without it, a resume after the key was consumed cannot export. The message says what is lost and the ways on: put the copy you saved into a file and pass `--recovery-copy-file`; or, deliberately, as root on the VPS delete `/var/lib/coxia-provision/recovery-copy-handed-over` and resume; or abandon the VPS and start a new move. (Any holder of the admin key can also read `/etc/coxia/master.key` as root on the VPS.)

## The journal

`$XDG_STATE_HOME/coxia-provision/moves/<move id>/move.json` (else `~/.local/state/...`), a 0700 folder with a 0600 file, written atomically. One entry per step try: `{step, at, result, detail}`, `result` one of `started`, `done`, `failed`, `unknown`, `skipped`, `rolled-back`; `rollback` and `destroy` entries record what was undone. It also holds the server id, the address, the host key fingerprints and the exported counts: no key, no token, no secret value. The folder also holds the admin key pair, the move's `known_hosts`, and `audit.log` (one line per create or destroy through the guard) sits in the `moves` folder.

## SSH and the host key

`src/ssh.ts` spawns the person's `ssh` and `scp` with fixed argument lists, `BatchMode=yes`, `IdentitiesOnly=yes`, password and keyboard-interactive off, and a `known_hosts` of the move's own (`GlobalKnownHostsFile=/dev/null`; your `~/.ssh/known_hosts` is neither used nor changed). Remote command words are quoted, host, user and remote path are validated before they reach an argument list.

Nothing the provider returns carries the machine's host key, so the first connection is `StrictHostKeyChecking=accept-new` (trust on first use). That session only waits for the machine and runs provisioning; nothing secret goes over it. `provisionMachine` then reads the fingerprints from the machine and the move compares them with what the first connection pinned (`ssh-keygen -l -f known_hosts`); a difference stops the move **before** the recovery copy is asked for or any data is sent. From then on every connection is `StrictHostKeyChecking=yes`.

Limit, said plainly: someone who relayed the whole first connection would relay the fingerprints too, and both would agree on their key. That is why the fingerprints are printed at the end: compare them with the provider's console.

## Threat notes

- **The admin door has no token.** Whoever can open the socket has the window's rights, including `move:export` on a moved-out workspace. Switch it on only for the move, from the desktop.
- **The tarball and the bundle hold your workspace**, with its secrets re-encrypted under the VPS key (so a stolen bundle is as safe as that key). They sit in a 0700 folder and are deleted at the end; on the VPS the tarball is deleted right after the import.
- **Whoever holds the admin key is root on the VPS.** The key stays in the move's folder on this computer.
- **A rollback does not undo money.** A purchase is a subscription; ending it is the provider's own terms (Hostinger: end of term).
- **The purchase is sent once** and never retried, by the adapter or by the move.

## Not verified on a real VPS

Nothing here ran against a real provider, a real machine or a real Coxia core. The tests use a fake provider, a fake ssh runner and a fake admin door (`test/move-world.ts`). Not verified: the real `ssh`/`scp` flags against OpenSSH on the VPS (`scp -O`, `accept-new` then pinned), the output format of `ssh-keygen -l -f` for every key type, `tar` packing, `coxia-server call <workspace> ownership:status` (assumed to print the status as JSON with a top-level `role`, and to run as the admin user without sudo like `coxia-server status`), `coxia-server import`'s result line, the channels `ownership:move-out`, `move:export` and `ownership:claim` (names and arguments are those of the contract, written in parallel), the currency a destroy ticket is closed with (the budget's; `USD` is sent today, which the core may refuse for another currency), a Hostinger purchase that waits for payment, and the 90 x 10 s wait for the machine.
