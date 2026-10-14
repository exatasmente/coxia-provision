# Releasing

`install.sh` is fetched from a tag's URL, so the copy under a tag must name that tag.

1. Land everything on `main` and make sure CI is green (`npm run typecheck`, `npm test`, `shellcheck deploy/provision.sh install.sh scripts/stamp-release.sh`, `node scripts/public-audit.mjs`).
2. On a release branch or detached, stamp the files: `scripts/stamp-release.sh v1.2.3 --server-ref <coxia-server tag or commit>` (the second part is optional; without it `--server-ref` stays `main` with a warning). It only rewrites the `PINNED_REF` and `PINNED_SERVER_REF` lines of `install.sh`.
3. Commit that change (`feat: stamp the release ref v1.2.3 #3`) and tag exactly that commit: `git tag v1.2.3`. `main` itself keeps `PINNED_REF=""`.
4. Push the tag and check the published copy: `curl -fsSL https://raw.githubusercontent.com/exatasmente/coxia-provision/v1.2.3/install.sh | grep '^PINNED_REF'`, then put its `sha256sum` in the release notes so people can check what they read.
5. Never move a tag. A wrong release gets a new tag.
