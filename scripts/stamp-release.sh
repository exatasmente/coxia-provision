#!/usr/bin/env bash
# Writes the release ref into install.sh, so the copy published under a tag fetches that same tag. Run it on the release commit
# (see RELEASING.md); it changes nothing else, and running it twice with the same tag is a no-op.
#
#   scripts/stamp-release.sh v1.0.0 [--server-ref <coxia-server tag or commit>] [--file <install.sh>]
set -euo pipefail

die() { printf 'stamp-release: %s\n' "$*" >&2; exit 1; }

file="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/install.sh"
tag="${1:-}"
[ -n "$tag" ] || die "usage: stamp-release.sh <tag> [--server-ref <ref>] [--file <install.sh>]"
shift
server_ref=""
while [ $# -gt 0 ]; do
  case "$1" in
    --server-ref) [ $# -ge 2 ] || die "--server-ref needs a value"; server_ref="$2"; shift ;;
    --file) [ $# -ge 2 ] || die "--file needs a value"; file="$2"; shift ;;
    *) die "unknown option $1" ;;
  esac
  shift
done

# The tag lands inside a double-quoted shell string, so it is held to a shape that cannot close it.
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || die "tag must look like v1.2.3 or v1.2.3-beta.1"
if [ -n "$server_ref" ]; then [[ "$server_ref" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || die "--server-ref is not a plain ref"; fi
[ -f "$file" ] || die "no such file: $file"
[ "$(grep -c '^PINNED_REF="' "$file")" -eq 1 ] || die "$file does not have exactly one PINNED_REF line"
[ "$(grep -c '^PINNED_SERVER_REF="' "$file")" -eq 1 ] || die "$file does not have exactly one PINNED_SERVER_REF line"

tmp="$(mktemp "$file.XXXXXX")"
sed -e "s|^PINNED_REF=\".*\"|PINNED_REF=\"$tag\"|" "$file" > "$tmp"
if [ -n "$server_ref" ]; then
  sed -i -e "s|^PINNED_SERVER_REF=\".*\"|PINNED_SERVER_REF=\"$server_ref\"|" "$tmp"
fi
chmod --reference="$file" "$tmp"
bash -n "$tmp" || { rm -f "$tmp"; die "the stamped file does not parse"; }
mv -f "$tmp" "$file"
printf 'stamped %s with %s%s\n' "$file" "$tag" "${server_ref:+ and server ref $server_ref}"
