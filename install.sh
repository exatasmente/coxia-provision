#!/usr/bin/env bash
# One-line installer: turns a fresh Ubuntu 24.04 VPS into a running Coxia instance.
#
#   curl -fsSL https://raw.githubusercontent.com/exatasmente/coxia-provision/<tag>/install.sh | sudo bash -s -- [options]
#
# Pin <tag>: a branch name moves under you. This file only fetches coxia-provision at --ref and hands over to its
# deploy/provision.sh, which does the work (firewall, sshd lockdown, upgrades, swap, coxia-server and its install.sh). Nothing here
# needs a credential; both repositories are fetched anonymously over https.
set -euo pipefail

# Stamped by scripts/stamp-release.sh on a release commit, so the file published under a tag fetches that same tag. Empty means this
# copy is not a release: it falls back to main and says so.
PINNED_REF=""
PINNED_SERVER_REF=""

PROVISION_REPO_URL="${COXIA_PROVISION_REPO_URL:-https://github.com/exatasmente/coxia-provision.git}"
SERVER_REPO_URL="${COXIA_SERVER_REPO_URL:-https://github.com/exatasmente/coxia-server.git}"

# Tests run the whole script against a throwaway root with stubbed commands. The real paths are the defaults and nothing outside
# the sandbox reads these three overrides.
ROOT=""
OS_RELEASE=/etc/os-release
TTY_PATH=/dev/tty
if [ "${COXIA_INSTALL_SANDBOX:-0}" = 1 ]; then
  ROOT="${COXIA_INSTALL_ROOT:?}"
  OS_RELEASE="${COXIA_INSTALL_OS_RELEASE:?}"
  TTY_PATH="${COXIA_INSTALL_TTY:?}"
fi
ENV_FILE="$ROOT/etc/coxia-provision.env"
ADMIN_KEYS_FILE="$ROOT/etc/coxia-provision.admin-keys"
SRC_ROOT="$ROOT/opt/coxia-provision"
BIN_PATH="$ROOT/usr/local/sbin/coxia-provision"

REF_RE='^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$'
KEY_RE='^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}( [[:print:]]*)?$'

say() { printf '==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'TXT'
Usage: curl -fsSL <raw url of install.sh at a tag> | sudo bash -s -- [options]

  --ref <ref>           coxia-provision tag, branch or commit to fetch (default: the tag this file was published under)
  --server-ref <ref>    coxia-server ref to install (a full commit id is the most fixed choice)
  --coxia-ref <tag>     public Coxia core tag the server builds (default: coxia-server's own)
  --admin-user <name>   the sudo user that holds the key (default: admin)
  --admin-key "<key>"   an ssh public key for that user; repeatable. Needed unless the user already has one
  --no-harden           leave sshd and the firewall alone (you manage this machine yourself)
  --swap <size>         swap file, for example 2G or 512M (default: leave swap alone)
  --timezone <tz>       IANA name, for example Etc/UTC (default: leave it)
  --force-os            run on something other than Ubuntu 24.04
  --yes                 do not ask for confirmation
  --help                this text
TXT
}

plain_ref() {
  [[ "$2" =~ $REF_RE ]] || die "$1 is not a plain git ref"
  [[ "$2" != *..* ]] || die "$1 is not a plain git ref"
}

# "2G", "512M" or a bare number of megabytes, as megabytes.
swap_to_mb() {
  local v="$1"
  [[ "$v" =~ ^([0-9]{1,5})([MmGg]?)$ ]] || die "--swap takes a size such as 2G or 512M"
  local n="${BASH_REMATCH[1]}"
  case "${BASH_REMATCH[2]}" in G | g) n=$((n * 1024)) ;; esac
  [ "$n" -le 65536 ] || die "--swap is over 64G"
  printf '%s' "$n"
}

write_file() {
  local path="$1" mode="$2" tmp
  tmp="$(mktemp "$path.XXXXXX")"
  cat > "$tmp"
  if [ -f "$path" ] && cmp -s "$tmp" "$path"; then
    rm -f "$tmp"
    chmod "$mode" "$path"
  else
    chmod "$mode" "$tmp"
    mv -f "$tmp" "$path"
  fi
}

check_platform() {
  [ "$(id -u)" -eq 0 ] || die "run as root: curl ... | sudo bash -s -- [options]"
  if [ "$FORCE_OS" != 1 ]; then
    local id version
    # shellcheck source=/dev/null
    id="$(. "$OS_RELEASE" && printf '%s' "${ID:-}")"
    # shellcheck source=/dev/null
    version="$(. "$OS_RELEASE" && printf '%s' "${VERSION_ID:-}")"
    if [ "$id" != ubuntu ] || [ "$version" != 24.04 ]; then
      die "this is written for Ubuntu 24.04 (found ${id:-unknown} ${version:-}); --force-os runs it anyway"
    fi
  fi
}

# Before anything is installed or touched: hardening leaves the admin user's key as the only way in, so no key means no way in.
check_lockout() {
  [ "$HARDEN" = 1 ] || return 0
  [ "${#ADMIN_KEYS[@]}" -eq 0 ] || return 0
  local home
  home="$(getent passwd "$ADMIN_USER" 2>/dev/null | cut -d: -f6 || true)"
  if [ -n "$home" ] && [ -s "$home/.ssh/authorized_keys" ]; then return 0; fi
  die "refusing to lock root out: hardening leaves only $ADMIN_USER's ssh key as a way in and none is installed.
Pass your public key:  --admin-key \"\$(cat ~/.ssh/id_ed25519.pub)\"  (or --no-harden if you manage sshd yourself)"
}

confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  local answer=""
  # The script itself arrives on standard input, so the answer comes from the terminal.
  if ! { read -r -p "Continue? [y/N] " answer < "$TTY_PATH"; } 2>/dev/null; then
    die "no terminal to ask on; pass --yes to go ahead"
  fi
  case "$answer" in y | Y | yes | YES) ;; *) die "cancelled" ;; esac
}

ensure_git() {
  command -v git >/dev/null 2>&1 && return 0
  say "git"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq < /dev/null
  apt-get install -y -qq --no-install-recommends ca-certificates git < /dev/null
}

# git, not a tarball: a tarball's checksum would have to be written in the file that the tarball itself contains, and a commit id is
# the one hash that does check the content. The fetch takes a tag, a branch or a full commit id, and a second run converges.
fetch_provision() {
  say "coxia-provision $REF"
  local dir="$SRC_ROOT/${REF//\//_}" head
  install -d -m 0755 "$SRC_ROOT"
  if [ ! -d "$dir/.git" ]; then
    rm -rf "$dir"
    git init -q "$dir"
  fi
  git -C "$dir" remote remove origin 2>/dev/null || true
  git -C "$dir" remote add origin "$PROVISION_REPO_URL"
  git -C "$dir" fetch -q --depth 1 origin "$REF"
  git -C "$dir" checkout -q --force --detach FETCH_HEAD
  git -C "$dir" clean -qfdx
  head="$(git -C "$dir" rev-parse HEAD)"
  if [[ "$REF" =~ ^[0-9a-f]{40}$ ]] && [ "$head" != "$REF" ]; then die "checked out $head, wanted $REF"; fi
  [ -f "$dir/deploy/provision.sh" ] || die "no deploy/provision.sh at $REF"
  SRC_DIR="$dir"
  say "at commit $head"
}

# The same KEY=value lines src/cloudInit.ts writes (a test keeps them together).
write_settings() {
  {
    printf 'ADMIN_USER=%s\n' "$ADMIN_USER"
    printf 'COXIA_SERVER_REPO_URL=%s\n' "$SERVER_REPO_URL"
    printf 'COXIA_SERVER_REF=%s\n' "$SERVER_REF"
    if [ -n "$COXIA_REF" ]; then printf 'COXIA_REF=%s\n' "$COXIA_REF"; fi
    printf 'SWAP_MB=%s\n' "$SWAP_MB"
    if [ -n "$TIMEZONE" ]; then printf 'TIMEZONE=%s\n' "$TIMEZONE"; fi
    if [ "$HARDEN" = 0 ]; then printf 'HARDEN=0\n'; fi
  } | write_file "$ENV_FILE" 0644
  if [ "${#ADMIN_KEYS[@]}" -gt 0 ]; then
    printf '%s\n' "${ADMIN_KEYS[@]}" | write_file "$ADMIN_KEYS_FILE" 0644
  fi
}

main() {
  # The last line of this file appends a marker; a download cut at the very end of the call lacks it and does nothing.
  if [ $# -eq 0 ] || [ "${!#}" != --end-of-script ]; then die "the script is incomplete (truncated download?); nothing was done"; fi
  set -- "${@:1:$#-1}"

  local ref_given=0 server_ref_given=0
  REF="${PINNED_REF:-main}"
  SERVER_REF="${PINNED_SERVER_REF:-main}"
  COXIA_REF=""
  ADMIN_USER="admin"
  ADMIN_KEYS=()
  HARDEN=1
  SWAP_MB=0
  TIMEZONE=""
  FORCE_OS=0
  ASSUME_YES=0
  SRC_DIR=""

  while [ $# -gt 0 ]; do
    case "$1" in
      --help | -h) usage; return 0 ;;
      --no-harden) HARDEN=0 ;;
      --force-os) FORCE_OS=1 ;;
      --yes | -y) ASSUME_YES=1 ;;
      --ref | --server-ref | --coxia-ref | --admin-user | --admin-key | --swap | --timezone)
        [ $# -ge 2 ] || die "$1 needs a value"
        case "$1" in
          --ref) REF="$2"; ref_given=1 ;;
          --server-ref) SERVER_REF="$2"; server_ref_given=1 ;;
          --coxia-ref) COXIA_REF="$2" ;;
          --admin-user) ADMIN_USER="$2" ;;
          --admin-key) ADMIN_KEYS+=("$2") ;;
          --swap) SWAP_MB="$(swap_to_mb "$2")" ;;
          --timezone) TIMEZONE="$2" ;;
        esac
        shift ;;
      *) die "unknown option $1 (see --help)" ;;
    esac
    shift
  done

  plain_ref --ref "$REF"
  # The checkout folder is named after the ref; this one is where coxia-server lives.
  [ "$REF" != coxia-server ] || die "--ref coxia-server is reserved"
  plain_ref --server-ref "$SERVER_REF"
  if [ -n "$COXIA_REF" ]; then plain_ref --coxia-ref "$COXIA_REF"; fi
  [[ "$ADMIN_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "--admin-user is not a usable user name"
  [ "$ADMIN_USER" != root ] || die "--admin-user cannot be root: hardening turns root logins off"
  if [ -n "$TIMEZONE" ]; then [[ "$TIMEZONE" =~ ^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+){0,2}$ ]] || die "--timezone is not an IANA name such as Etc/UTC"; fi
  local key
  for key in "${ADMIN_KEYS[@]}"; do
    [ -n "$key" ] || continue
    case "$key" in *PRIVATE\ KEY*) die "--admin-key got a private key; give the public half (.pub)" ;; esac
    [[ "$key" =~ $KEY_RE ]] || die "--admin-key is not a single-line OpenSSH public key"
  done

  check_platform
  check_lockout

  if [ "$ref_given" = 0 ] && [ -z "$PINNED_REF" ]; then
    warn "coxia-provision ref is not pinned: using main, which moves. Fetch install.sh from a tag, or pass --ref <tag>."
  fi
  if [ "$server_ref_given" = 0 ] && [ -z "$PINNED_SERVER_REF" ]; then
    warn "coxia-server ref is not pinned: using main. Pass --server-ref <tag or commit>."
  fi
  if [ "$HARDEN" = 0 ]; then
    warn "--no-harden: sshd is NOT locked down and the firewall is NOT enabled. Password and root logins stay as they are; securing this machine is up to you."
  fi

  say "Coxia install"
  printf '    coxia-provision  %s\n    coxia-server     %s\n    admin user       %s (%s key(s) given)\n    hardening        %s\n' \
    "$REF" "$SERVER_REF" "$ADMIN_USER" "${#ADMIN_KEYS[@]}" "$([ "$HARDEN" = 1 ] && echo 'ssh lockdown + firewall' || echo 'skipped')"
  confirm

  export GIT_TERMINAL_PROMPT=0
  ensure_git
  fetch_provision
  install -d -m 0755 "$ROOT/etc" "$(dirname "$BIN_PATH")"
  write_settings
  # `sudo coxia-provision recovery-copy` is how the one recovery copy is taken, so the script goes where cloud-init puts it.
  write_file "$BIN_PATH" 0755 < "$SRC_DIR/deploy/provision.sh"

  # The script's own stdin is this very script when piped, so the children get none.
  "$BIN_PATH" provision < /dev/null
  "$BIN_PATH" next-steps < /dev/null
}

main "$@" --end-of-script
