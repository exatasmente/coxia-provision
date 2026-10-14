// Renders the cloud-config user-data of a fresh VPS. Pure: the same input gives the same bytes, and the input holds no secret.
//
// Providers keep user-data readable through their metadata API for as long as the machine lives, so it carries public keys, a ref and
// a timezone and nothing else. The master key is made on the machine and leaves it over SSH (see provision.ts).
import { gzipSync } from 'node:zlib';

export const PROVISION_PATH = '/usr/local/sbin/coxia-provision';
export const PROVISION_ENV_PATH = '/etc/coxia-provision.env';
/** Public keys for the admin user, one per line; provision.sh creates the user from it (install.sh and the post-install script). */
export const PROVISION_ADMIN_KEYS_PATH = '/etc/coxia-provision.admin-keys';
export const DEFAULT_ADMIN_USER = 'admin';
export const DEFAULT_SERVER_REPO_URL = 'https://github.com/exatasmente/coxia-server.git';
// Several providers refuse user-data above 16 KiB.
export const MAX_USER_DATA_BYTES = 16 * 1024;

/** The lines of the sshd drop-in; deploy/provision.sh writes the same ones (a test keeps them together). */
export const SSHD_HARDENING = [
  'PasswordAuthentication no',
  'KbdInteractiveAuthentication no',
  'PermitRootLogin no',
  'PermitEmptyPasswords no',
  'PubkeyAuthentication yes',
  'AuthenticationMethods publickey',
  'X11Forwarding no',
  'MaxAuthTries 3',
] as const;

export interface CloudInitInput {
  /** The person's public key(s), one authorized_keys line each. They are the only way in. */
  adminPublicKeys: readonly string[];
  /** The coxia-server ref to provision: a full commit id is the deterministic choice, a tag is accepted. */
  serverRef: string;
  /** The contents of deploy/provision.sh at that same commit, embedded so nothing is fetched to start. */
  provisionScript: string;
  /** IANA name, for example `Etc/UTC` or `Area/City`. */
  timezone: string;
  /** Swap file size in MB; absent or 0 leaves swap alone. */
  swapMb?: number;
  /** The sudo user that holds the key. Default `admin`. */
  adminUser?: string;
  /** Where coxia-server is fetched from. Default is the project's repository. */
  serverRepoUrl?: string;
  /** The Coxia release the server builds (install.sh's COXIA_REF); absent keeps install.sh's default. */
  coxiaRef?: string;
}

/** What lands in /etc/coxia-provision.env; install.sh writes the same lines in the same order. */
export interface ProvisionSettings {
  adminUser?: string;
  serverRepoUrl?: string;
  serverRef: string;
  coxiaRef?: string;
  swapMb?: number;
  timezone?: string;
  /** false writes HARDEN=0: provision.sh then leaves sshd and the firewall alone. Default true. */
  harden?: boolean;
}

export class CloudInitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudInitError';
  }
}

const KEY_TYPES = 'ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\\.com|sk-ecdsa-sha2-nistp256@openssh\\.com';
const PUBLIC_KEY = new RegExp(`^(?:${KEY_TYPES}) [A-Za-z0-9+/]+={0,3}(?: [\\x20-\\x7e]*)?$`);
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const TIMEZONE = /^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+){0,2}$/;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const HTTPS_URL = /^https:\/\/[A-Za-z0-9._~:/@%+-]+$/;

function checkRef(name: string, ref: string): void {
  if (!REF.test(ref) || ref.includes('..')) throw new CloudInitError(`${name} is not a plain git ref`);
}

export function validatePublicKeys(keys: readonly string[]): void {
  for (const key of keys) {
    if (/PRIVATE KEY/.test(key)) throw new CloudInitError('a private key was given where a public key belongs');
    if (!PUBLIC_KEY.test(key)) throw new CloudInitError('an admin key is not a single-line OpenSSH public key');
  }
}

export function validateSettings(input: ProvisionSettings): void {
  checkRef('serverRef', input.serverRef);
  if (input.coxiaRef !== undefined) checkRef('coxiaRef', input.coxiaRef);
  if (input.timezone !== undefined && !TIMEZONE.test(input.timezone)) throw new CloudInitError('timezone is not an IANA name such as Etc/UTC');
  if (input.swapMb !== undefined && (!Number.isInteger(input.swapMb) || input.swapMb < 0 || input.swapMb > 65536)) {
    throw new CloudInitError('swapMb must be a whole number of MB between 0 and 65536');
  }
  if (input.adminUser !== undefined && (!USER.test(input.adminUser) || input.adminUser === 'root')) throw new CloudInitError('adminUser is not a usable non-root user name');
  if (input.serverRepoUrl !== undefined && !HTTPS_URL.test(input.serverRepoUrl)) throw new CloudInitError('serverRepoUrl must be an https URL');
}

export function validateInput(input: CloudInitInput): void {
  if (input.adminPublicKeys.length === 0) throw new CloudInitError('at least one admin public key is needed: without it nobody can log in');
  validatePublicKeys(input.adminPublicKeys);
  validateSettings(input);
  if (!input.timezone) throw new CloudInitError('timezone is not an IANA name such as Etc/UTC');
  if (!input.provisionScript.startsWith('#!')) throw new CloudInitError('provisionScript does not look like a script');
}

// JSON strings are valid YAML double-quoted scalars, so a value can never break out of its line.
const q = (value: string): string => JSON.stringify(value);

export function renderProvisionEnv(input: ProvisionSettings): string {
  validateSettings(input);
  return [
    `ADMIN_USER=${input.adminUser ?? DEFAULT_ADMIN_USER}`,
    `COXIA_SERVER_REPO_URL=${input.serverRepoUrl ?? DEFAULT_SERVER_REPO_URL}`,
    `COXIA_SERVER_REF=${input.serverRef}`,
    ...(input.coxiaRef === undefined ? [] : [`COXIA_REF=${input.coxiaRef}`]),
    `SWAP_MB=${input.swapMb ?? 0}`,
    ...(input.timezone === undefined ? [] : [`TIMEZONE=${input.timezone}`]),
    ...(input.harden === false ? ['HARDEN=0'] : []),
  ].join('\n') + '\n';
}

export function renderCloudInit(input: CloudInitInput): string {
  validateInput(input);
  const user = input.adminUser ?? DEFAULT_ADMIN_USER;
  const settings = renderProvisionEnv(input);
  const sshd = [...SSHD_HARDENING, `AllowUsers ${user}`].join('\n') + '\n';
  // Compressed: the plain script is over the size some providers accept.
  const script = gzipSync(Buffer.from(input.provisionScript, 'utf8'), { level: 9 }).toString('base64');

  const out = [
    '#cloud-config',
    '# Rendered by coxia-provision. Holds public keys and settings only; no secret belongs here.',
    // Ubuntu already has a group named `admin`, and creating the user with a group of its own name then fails. Declaring the group makes
    // cloud-init create it where it is missing and skip it where it exists; the user then takes it as its primary group.
    'groups:',
    `  - ${q(user)}`,
    'users:',
    `  - name: ${q(user)}`,
    `    primary_group: ${q(user)}`,
    '    groups: [sudo]',
    '    shell: /bin/bash',
    '    lock_passwd: true',
    // The account has no password, so sudo cannot ask for one; the key is the credential for both.
    `    sudo: ${q('ALL=(ALL) NOPASSWD:ALL')}`,
    '    ssh_authorized_keys:',
    ...input.adminPublicKeys.map((k) => `      - ${q(k)}`),
    'disable_root: true',
    'ssh_pwauth: false',
    `timezone: ${q(input.timezone)}`,
    'write_files:',
    '  - path: /etc/ssh/sshd_config.d/00-coxia-hardening.conf',
    '    permissions: "0644"',
    '    content: |',
    ...sshd.trimEnd().split('\n').map((l) => `      ${l}`),
    `  - path: ${PROVISION_ENV_PATH}`,
    '    permissions: "0644"',
    '    content: |',
    ...settings.trimEnd().split('\n').map((l) => `      ${l}`),
    `  - path: ${PROVISION_PATH}`,
    '    permissions: "0755"',
    '    encoding: gz+b64',
    `    content: ${q(script)}`,
    'runcmd:',
    `  - [${q(PROVISION_PATH)}, "provision"]`,
    '',
  ].join('\n');

  const size = Buffer.byteLength(out, 'utf8');
  if (size > MAX_USER_DATA_BYTES) throw new CloudInitError(`user-data is ${size} bytes, over the ${MAX_USER_DATA_BYTES} some providers accept`);
  return out;
}
