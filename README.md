# Coxia Provision

How a Coxia instance moves to a VPS on its own: a provider interface for buying and managing the machine within a budget, cloud-init and the provisioning script, the handover of a workspace from one instance to another, snapshots before each update, rollback when the health check fails, and the external uptime monitor.

## Status

Private while Coxia works towards 1.0. It becomes public with the 1.0 release, so
everything here is written as if it were public already: no company, person, host,
real issue number or secret in code, tests, docs, commit messages or branch names.
`node scripts/public-audit.mjs` enforces that in CI. The script is a copy of the
one in the Coxia repository; keep them in sync.

## How it fits

The Coxia core and its client contract live in the public repository
[exatasmente/coxia](https://github.com/exatasmente/coxia). This repository depends
on them; the public repository never depends on this one.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
