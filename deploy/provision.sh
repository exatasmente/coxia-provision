#!/usr/bin/env bash
# Turns a fresh Ubuntu 24.04 VPS into a Coxia instance. Runs as root; cloud-init puts it at /usr/local/sbin/coxia-provision and
# runs `provision` once, and the client (src/provision.ts) runs it again over SSH. Every step converges, so running it twice
# leaves the machine the same.
#
#   coxia-provision provision       firewall, ssh hardening, unattended upgrades, swap, coxia-server at its pinned ref + install.sh
#   coxia-provision next-steps      the host key fingerprints and what to do next (pair a device, take the recovery copy)
#   coxia-provision host-keys       the SHA256 fingerprints of the SSH host keys, one "<type> SHA256:<base64>" per line
#   coxia-provision recovery-copy   prints the master key once, to standard output only, and records that it was handed over
#
# Settings come from /etc/coxia-provision.env (KEY=value lines written by cloud-init, a post-install script or install.sh; no secrets,
# parsed, never sourced). When /etc/coxia-provision.admin-keys exists (public keys, one per line) the admin user is created from it.
set -euo pipefail

# --- paths -----------------------------------------------------------------------------------------------------------------------
ENV_FILE=/etc/coxia-provision.env
STATE_DIR=/var/lib/coxia-provision        # root-only; outside the data folder and out of its backups
KEY_FILE=/etc/coxia/master.key            # where coxia-server's install.sh keeps it (COXIA_MASTER_KEY_FILE)
SSH_DIR=/etc/ssh
ADMIN_KEYS_FILE=/etc/coxia-provision.admin-keys
SUDOERS_DIR=/etc/sudoers.d
SRC_ROOT=/opt/coxia-provision
SERVER_SRC="$SRC_ROOT/coxia-server"

# Tests point the read-only subcommands at a throwaway folder. `provision` refuses this mode, so it can never move the real paths.
SANDBOX="${COXIA_PROVISION_SANDBOX:-0}"
if [ "$SANDBOX" = 1 ]; then
  STATE_DIR="${COXIA_PROVISION_STATE_DIR:?}"
  KEY_FILE="${COXIA_PROVISION_KEY_FILE:?}"
  SSH_DIR="${COXIA_PROVISION_SSH_DIR:?}"
fi
MARKER="$STATE_DIR/recovery-copy-handed-over"

say() { printf '==> %s\n' "$*"; }
die() { printf 'provision: %s\n' "$*" >&2; exit 1; }

# --- settings --------------------------------------------------------------------------------------------------------------------
COXIA_SERVER_REPO_URL=""
COXIA_SERVER_REF=""
COXIA_REF=""
COXIA_VOICE_MODEL=""
NODE_SHA256=""
ADMIN_USER="admin"
SWAP_MB=0
TIMEZONE=""
# 0 leaves sshd and the firewall to the person (install.sh --no-harden).
HARDEN=1

load_env() {
  [ -f "$ENV_FILE" ] || return 0
  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | '#'*) continue ;; esac
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      COXIA_SERVER_REPO_URL | COXIA_SERVER_REF | COXIA_REF | COXIA_VOICE_MODEL | NODE_SHA256 | ADMIN_USER | SWAP_MB | TIMEZONE | HARDEN)
        printf -v "$key" '%s' "$value" ;;
      *) die "unknown setting $key in $ENV_FILE" ;;
    esac
  done < "$ENV_FILE"
}

# A value ends up in a git command line, a file name or a shell word, so each is held to a narrow shape.
validate_settings() {
  [[ "$COXIA_SERVER_REF" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$ ]] || die "COXIA_SERVER_REF is missing or not a plain ref"
  [[ "$COXIA_SERVER_REF" != *..* ]] || die "COXIA_SERVER_REF is not a plain ref"
  [[ "$COXIA_SERVER_REPO_URL" =~ ^https://[A-Za-z0-9._~:/@%+-]+$ ]] || die "COXIA_SERVER_REPO_URL must be an https URL"
  [[ "$ADMIN_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "ADMIN_USER is not a valid user name"
  [[ "$SWAP_MB" =~ ^[0-9]{1,6}$ ]] || die "SWAP_MB must be a number of megabytes"
  [[ "$HARDEN" =~ ^[01]$ ]] || die "HARDEN must be 0 or 1"
  if [ -n "$TIMEZONE" ]; then [[ "$TIMEZONE" =~ ^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+){0,2}$ ]] || die "TIMEZONE is not an IANA name"; fi
  if [ -n "$COXIA_REF" ]; then [[ "$COXIA_REF" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$ ]] || die "COXIA_REF is not a plain ref"; fi
  if [ -n "$COXIA_VOICE_MODEL" ]; then [[ "$COXIA_VOICE_MODEL" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || die "COXIA_VOICE_MODEL is not a plain name"; fi
  if [ -n "$NODE_SHA256" ]; then [[ "$NODE_SHA256" =~ ^[0-9a-f]{64}$ ]] || die "NODE_SHA256 is not 64 hex digits"; fi
  return 0
}

# Writes stdin to <path> with <mode>, touching the file only when the content differs.
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

# --- packages --------------------------------------------------------------------------------------------------------------------
install_packages() {
  say "packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends ca-certificates curl git openssl openssh-server ufw unattended-upgrades iproute2
}

# --- admin user ------------------------------------------------------------------------------------------------------------------
# cloud-init makes the user itself; install.sh and the post-install script hand the keys over in $ADMIN_KEYS_FILE and this step does
# the same: a user with no password, sudo without one (the key is the credential), the keys in authorized_keys. Keys are only added,
# never removed, so a second run changes nothing and a key the person added by hand survives.
setup_admin() {
  [ -f "$ADMIN_KEYS_FILE" ] || return 0
  say "admin user $ADMIN_USER"
  local line n=0 home keys
  local key_re='^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}( [[:print:]]*)?$'
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    [[ "$line" =~ $key_re ]] || die "$ADMIN_KEYS_FILE has a line that is not a single OpenSSH public key"
    n=$((n + 1))
  done < "$ADMIN_KEYS_FILE"
  [ "$n" -gt 0 ] || die "$ADMIN_KEYS_FILE holds no key"
  if ! id "$ADMIN_USER" >/dev/null 2>&1; then
    useradd --create-home --shell /bin/bash --groups sudo "$ADMIN_USER"
    passwd -l "$ADMIN_USER" >/dev/null
  fi
  write_file "$SUDOERS_DIR/90-coxia-admin" 0440 <<CONF
$ADMIN_USER ALL=(ALL) NOPASSWD:ALL
CONF
  visudo -cf "$SUDOERS_DIR/90-coxia-admin" >/dev/null || { rm -f "$SUDOERS_DIR/90-coxia-admin"; die "sudoers entry rejected by visudo"; }
  home="$(getent passwd "$ADMIN_USER" | cut -d: -f6)"
  keys="$home/.ssh/authorized_keys"
  install -d -m 0700 -o "$ADMIN_USER" -g "$ADMIN_USER" "$home/.ssh"
  [ -e "$keys" ] || install -m 0600 -o "$ADMIN_USER" -g "$ADMIN_USER" /dev/null "$keys"
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    grep -qxF -- "$line" "$keys" || printf '%s\n' "$line" >> "$keys"
  done < "$ADMIN_KEYS_FILE"
  chown "$ADMIN_USER:$ADMIN_USER" "$keys"
  chmod 0600 "$keys"
}

# --- timezone --------------------------------------------------------------------------------------------------------------------
setup_timezone() {
  [ -n "$TIMEZONE" ] || return 0
  say "timezone $TIMEZONE"
  [ "$(timedatectl show -p Timezone --value)" = "$TIMEZONE" ] || timedatectl set-timezone "$TIMEZONE"
}

# --- ssh -------------------------------------------------------------------------------------------------------------------------
# Same lines as src/cloudInit.ts, so a machine whose cloud-init never ran to the end is hardened by this step as well. Root cannot log
# in at all: the one way in is the admin user's key, and sudo is the only way up (see docs/provisioning.md).
harden_ssh() {
  say "ssh hardening"
  id "$ADMIN_USER" >/dev/null 2>&1 || die "user $ADMIN_USER does not exist; refusing to lock out password and root logins"
  local home keys
  home="$(getent passwd "$ADMIN_USER" | cut -d: -f6)"
  keys="$home/.ssh/authorized_keys"
  [ -s "$keys" ] || die "$keys is empty; refusing to lock out password and root logins"
  ssh-keygen -A >/dev/null
  install -d -m 0755 "$SSH_DIR/sshd_config.d"
  write_file "$SSH_DIR/sshd_config.d/00-coxia-hardening.conf" 0644 <<CONF
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PermitEmptyPasswords no
PubkeyAuthentication yes
AuthenticationMethods publickey
AllowUsers $ADMIN_USER
X11Forwarding no
MaxAuthTries 3
CONF
  sshd -t
  local effective
  effective="$(sshd -T)"
  grep -qx 'passwordauthentication no' <<< "$effective" || die "sshd still allows passwords; a file read before ours wins"
  grep -qx 'permitrootlogin no' <<< "$effective" || die "sshd still allows root login; a file read before ours wins"
  grep -qx 'port 22' <<< "$effective" || die "sshd does not listen on port 22 only; the firewall below allows 22"
  systemctl reload ssh 2>/dev/null || systemctl reload sshd
}

# --- firewall --------------------------------------------------------------------------------------------------------------------
# Deny everything in, allow SSH. The core listens on 127.0.0.1 only; this is the second wall, not the first.
setup_firewall() {
  say "firewall"
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow 22/tcp >/dev/null
  ufw --force enable >/dev/null
  ufw status | grep -q '^Status: active' || die "ufw is not active"
}

# --- unattended upgrades ---------------------------------------------------------------------------------------------------------
# Security updates install on their own. No automatic reboot: the supervisor restarts the cores, but a reboot at an hour nobody chose
# would cut a running agent; `/var/run/reboot-required` is the person's cue.
setup_upgrades() {
  say "unattended upgrades"
  write_file /etc/apt/apt.conf.d/20auto-upgrades 0644 <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF
  write_file /etc/apt/apt.conf.d/52coxia-unattended-upgrades 0644 <<'CONF'
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
CONF
  systemctl enable --now apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 || true
}

# --- swap ------------------------------------------------------------------------------------------------------------------------
# A small VPS builds the Coxia release (npm ci, electron-vite) close to its memory. 0 leaves swap alone.
setup_swap() {
  if [ "$SWAP_MB" -eq 0 ]; then return 0; fi
  say "swap ${SWAP_MB} MB"
  local file=/swapfile want=$((SWAP_MB * 1024 * 1024))
  if [ -f "$file" ] && [ "$(stat -c %s "$file")" -eq "$want" ] && swapon --noheadings --show=NAME | grep -qx "$file"; then return 0; fi
  if swapon --noheadings --show=NAME | grep -qx "$file"; then swapoff "$file"; fi
  rm -f "$file"
  ( umask 077; fallocate -l "$want" "$file" 2>/dev/null || dd if=/dev/zero of="$file" bs=1M count="$SWAP_MB" status=none )
  chmod 0600 "$file"
  mkswap "$file" >/dev/null
  swapon "$file"
  if ! grep -qs "^$file " /etc/fstab; then echo "$file none swap sw 0 0" >> /etc/fstab; fi
}

# --- coxia-server ----------------------------------------------------------------------------------------------------------------
# The checkout is detached at the pinned ref and cleaned, so a second run lands on the same tree. A full commit id is checked
# against what git resolved; a tag or branch is only as fixed as the remote keeps it (the docs say to pin a commit).
checkout_server() {
  say "coxia-server $COXIA_SERVER_REF"
  install -d -m 0755 "$SRC_ROOT"
  if [ ! -d "$SERVER_SRC/.git" ]; then
    rm -rf "$SERVER_SRC"
    git init -q "$SERVER_SRC"
  fi
  git -C "$SERVER_SRC" remote remove origin 2>/dev/null || true
  git -C "$SERVER_SRC" remote add origin "$COXIA_SERVER_REPO_URL"
  git -C "$SERVER_SRC" fetch -q --depth 1 origin "$COXIA_SERVER_REF"
  git -C "$SERVER_SRC" checkout -q --force --detach FETCH_HEAD
  git -C "$SERVER_SRC" clean -qfdx
  local head
  head="$(git -C "$SERVER_SRC" rev-parse HEAD)"
  if [[ "$COXIA_SERVER_REF" =~ ^[0-9a-f]{40}$ ]] && [ "$head" != "$COXIA_SERVER_REF" ]; then die "checked out $head, wanted $COXIA_SERVER_REF"; fi
  [ -x "$SERVER_SRC/deploy/install.sh" ] || die "no deploy/install.sh at $COXIA_SERVER_REF"
  SERVER_COMMIT="$head"
}

# coxia-server's install.sh does the rest (Node with its checksum, bubblewrap, the AppArmor profile, the coxia user, the build, the
# voice sidecar, the unit) and is safe to run again; it is not copied here.
run_install() {
  say "install.sh"
  local -a vars=()
  if [ -n "$COXIA_REF" ]; then vars+=("COXIA_REF=$COXIA_REF"); fi
  if [ -n "$COXIA_VOICE_MODEL" ]; then vars+=("COXIA_VOICE_MODEL=$COXIA_VOICE_MODEL"); fi
  if [ -n "$NODE_SHA256" ]; then vars+=("NODE_SHA256=$NODE_SHA256"); fi
  ( cd "$SERVER_SRC" && env "${vars[@]}" ./deploy/install.sh )
}

# install.sh creates the master key once (64 hex digits, 0600, /etc/coxia, outside the data folder) and never overwrites it, which is
# also how a second run leaves it alone. Generating another here would orphan every stored secret, so a missing or malformed file stops the run.
check_master_key() {
  say "master key"
  [ -f "$KEY_FILE" ] || die "$KEY_FILE is missing after install.sh"
  [ "$(stat -c %a "$KEY_FILE")" = 600 ] || die "$KEY_FILE is not mode 0600"
  [[ "$(cat "$KEY_FILE")" =~ ^[0-9a-f]{64}$ ]] || die "$KEY_FILE is not 64 hex digits"
}

# Nothing but ssh may listen on a public address.
check_listeners() {
  say "listeners"
  local bad
  bad="$(ss -H -ltn | awk '{print $4}' | grep -Ev '^(127\.|\[::1\]:|\[::ffff:127\.)' | grep -Ev ':22$' || true)"
  if [ -z "$bad" ]; then return 0; fi
  if [ "$HARDEN" = 1 ]; then die "listening beyond loopback and ssh: $bad"; fi
  echo "warning: listening beyond loopback and ssh: $bad" >&2
}

# --- host keys -------------------------------------------------------------------------------------------------------------------
print_host_keys() {
  local type file found=0
  for type in ed25519 ecdsa rsa; do
    file="$SSH_DIR/ssh_host_${type}_key.pub"
    [ -f "$file" ] || continue
    printf '%s %s\n' "$type" "$(ssh-keygen -lf "$file" -E sha256 | awk '{print $2}')"
    found=1
  done
  [ "$found" = 1 ] || die "no SSH host key in $SSH_DIR"
}

# --- the recovery copy -----------------------------------------------------------------------------------------------------------
# The key leaves the machine once, on standard output, over the SSH channel that ran this command. Nothing else is printed there, and
# nothing here writes it to a log. The marker is made before the key is printed: if the transfer then breaks, the copy is lost to
# the person rather than offered twice (the key is still in $KEY_FILE for root; deleting the marker is a deliberate act).
recovery_copy() {
  if [ -e "$MARKER" ]; then
    echo "provision: the recovery copy was already handed over ($(cat "$MARKER" 2>/dev/null || true))" >&2
    exit 3
  fi
  local key
  [ -f "$KEY_FILE" ] || { echo "provision: no master key at $KEY_FILE" >&2; exit 4; }
  key="$(cat "$KEY_FILE")"
  [[ "$key" =~ ^[0-9a-f]{64}$ ]] || { echo "provision: the master key file is not 64 hex digits" >&2; exit 4; }
  install -d -m 0700 "$STATE_DIR"
  # noclobber makes the creation atomic: of two racing requests only one gets the key.
  if ! ( set -o noclobber; printf 'handed over %s to %s\n' "$(date -u +%FT%TZ)" "${SUDO_USER:-root}" > "$MARKER" ) 2>/dev/null; then
    echo "provision: the recovery copy was already handed over" >&2
    exit 3
  fi
  chmod 0600 "$MARKER"
  printf '%s\n' "$key"
}

# --- what to do next -------------------------------------------------------------------------------------------------------------
# Printed by install.sh and the post-install script when provisioning ends. The recovery copy is described and never printed here.
next_steps() {
  say "SSH host keys (compare them with what ssh shows on your first connection)"
  print_host_keys
  cat <<TXT

==> next steps
  Pair a device (a pairing code and the tunnel to reach the instance, as $ADMIN_USER):
      coxia-server pair [workspace]
  Take the one recovery copy of the master key. It works ONCE: the key is printed once, nothing keeps a copy
  for you, and a lost transfer is lost. Run it in your own terminal and store the output in a password manager:
      sudo coxia-provision recovery-copy
TXT
  if [ "$HARDEN" = 1 ]; then
    echo "  Root can no longer log in over ssh; use: ssh $ADMIN_USER@<this machine>"
  else
    echo "  Hardening was skipped: sshd and the firewall are yours to manage."
  fi
}

# --- main ------------------------------------------------------------------------------------------------------------------------
provision() {
  [ "$SANDBOX" != 1 ] || die "provision does not run in sandbox mode"
  load_env
  validate_settings
  # shellcheck source=/dev/null
  . /etc/os-release
  if [ "${ID:-}" != ubuntu ] || [ "${VERSION_ID:-}" != 24.04 ]; then echo "warning: written for Ubuntu 24.04, this is ${PRETTY_NAME:-unknown}" >&2; fi
  install -d -m 0700 "$STATE_DIR"
  install_packages
  setup_admin
  setup_timezone
  if [ "$HARDEN" = 1 ]; then
    harden_ssh
    setup_firewall
  else
    echo "warning: HARDEN=0, sshd and the firewall are left as they are" >&2
  fi
  setup_upgrades
  setup_swap
  checkout_server
  run_install
  check_master_key
  check_listeners
  printf 'server_ref=%s\nserver_commit=%s\ncompleted=%s\n' "$COXIA_SERVER_REF" "$SERVER_COMMIT" "$(date -u +%FT%TZ)" > "$STATE_DIR/provisioned"
  say "SSH host keys"
  print_host_keys
  say "done"
}

SERVER_COMMIT=""
[ "$SANDBOX" = 1 ] || [ "$(id -u)" -eq 0 ] || die "run as root (sudo)"

case "${1:-}" in
  provision) provision ;;
  host-keys) print_host_keys ;;
  next-steps) load_env; next_steps ;;
  recovery-copy) recovery_copy ;;
  *) echo "usage: coxia-provision provision | next-steps | host-keys | recovery-copy" >&2; exit 2 ;;
esac
