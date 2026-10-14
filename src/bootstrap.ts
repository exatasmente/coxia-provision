// The same install as install.sh, as one self-contained bash script for a provider's post-install hook (no curl|bash, nothing fetched
// for the script itself): it writes the settings, the admin keys and provision.sh, then runs `provision` and `next-steps`. Pure, and
// like the cloud-init user-data it holds public keys and settings only: providers keep these scripts readable.
import { gzipSync } from 'node:zlib';
import {
  CloudInitError,
  PROVISION_ADMIN_KEYS_PATH,
  PROVISION_ENV_PATH,
  PROVISION_PATH,
  renderProvisionEnv,
  validatePublicKeys,
  type ProvisionSettings,
} from './cloudInit.ts';

// Hostinger takes a post-install script up to 48 KB.
export const MAX_POST_INSTALL_BYTES = 48 * 1024;

export interface PostInstallInput extends ProvisionSettings {
  /** Public keys of the admin user. Required unless `harden` is false, because hardening leaves the key as the only way in. */
  adminPublicKeys?: readonly string[];
  /** The contents of deploy/provision.sh to embed (the version that goes with this release). */
  provisionScript: string;
}

export function renderPostInstallScript(input: PostInstallInput): string {
  const keys = input.adminPublicKeys ?? [];
  if (input.harden !== false && keys.length === 0) {
    throw new CloudInitError('at least one admin public key is needed: hardening leaves it as the only way in (or set harden to false)');
  }
  validatePublicKeys(keys);
  if (!input.provisionScript.startsWith('#!')) throw new CloudInitError('provisionScript does not look like a script');
  const env = renderProvisionEnv(input);
  const script = gzipSync(Buffer.from(input.provisionScript, 'utf8'), { level: 9 }).toString('base64').replace(/(.{76})/g, '$1\n');

  const out = [
    '#!/usr/bin/env bash',
    '# Rendered by coxia-provision. Public keys and settings only; no secret belongs here.',
    'set -euo pipefail',
    '',
    '# Everything is inside main, called on the last line: a script cut short does nothing.',
    'main() {',
    '  [ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }',
    '  export DEBIAN_FRONTEND=noninteractive',
    '  install -d -m 0755 /etc /usr/local/sbin',
    `  cat > ${PROVISION_ENV_PATH} <<'COXIA_SETTINGS_EOF'`,
    env.trimEnd(),
    'COXIA_SETTINGS_EOF',
    `  chmod 0644 ${PROVISION_ENV_PATH}`,
    ...(keys.length === 0
      ? []
      : [
          `  cat > ${PROVISION_ADMIN_KEYS_PATH} <<'COXIA_KEYS_EOF'`,
          ...keys,
          'COXIA_KEYS_EOF',
          `  chmod 0644 ${PROVISION_ADMIN_KEYS_PATH}`,
        ]),
    `  base64 -d <<'COXIA_SCRIPT_EOF' | gunzip > ${PROVISION_PATH}`,
    script.trimEnd(),
    'COXIA_SCRIPT_EOF',
    `  chmod 0755 ${PROVISION_PATH}`,
    `  ${PROVISION_PATH} provision < /dev/null`,
    `  ${PROVISION_PATH} next-steps < /dev/null`,
    '}',
    '',
    'main "$@"',
    '',
  ].join('\n');

  const size = Buffer.byteLength(out, 'utf8');
  if (size > MAX_POST_INSTALL_BYTES) throw new CloudInitError(`post-install script is ${size} bytes, over the ${MAX_POST_INSTALL_BYTES} the provider accepts`);
  return out;
}
