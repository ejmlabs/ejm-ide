import type { PublicReleaseManifest, ReleaseTarget } from '../../distribution/manifest';
import { detectPlatform, formatBytes, loadReleases, type Platform } from './release';

const installers: { target: ReleaseTarget; platform: Platform; name: string }[] = [
  { target: 'darwin-aarch64', platform: 'macos', name: 'macOS, Apple Silicon' },
  { target: 'darwin-x86_64', platform: 'macos', name: 'macOS, Intel' },
  { target: 'windows-x86_64', platform: 'windows', name: 'Windows, 64-bit' },
  { target: 'linux-x86_64', platform: 'linux', name: 'Linux, 64-bit' },
];

type ReleaseState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; manifest: PublicReleaseManifest };

function required<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`ejm-ide page element is missing: ${selector}`);
  return node;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const heroLabel = required<HTMLSpanElement>('#hero-download-label');
const heroStatus = required<HTMLParagraphElement>('#hero-release-status');
const sourceSlot = required<HTMLSpanElement>('[data-source-slot]');
const table = required<HTMLElement>('#download-table');
const rows = required<HTMLElement>('#download-rows');
const status = required<HTMLElement>('#release-status');
const message = required<HTMLParagraphElement>('#release-message');
const yourPlatform = detectPlatform(navigator.userAgent);
let activeRequest: AbortController | undefined;
let retry: HTMLButtonElement | undefined;

function renderRows(manifest?: PublicReleaseManifest): void {
  rows.replaceChildren();
  for (const installer of installers) {
    const artifact = manifest?.artifacts.find((item) => item.target === installer.target);
    const row = element('tr');
    const name = element('th', undefined, installer.name);
    name.scope = 'row';
    if (installer.platform === yourPlatform) {
      name.append(' ', element('span', 'ejm-tag ejm-tag--quiet', 'your platform'));
    }
    const file = element('td');
    const action = element('td');
    if (artifact) {
      file.append(
        `${artifact.filename} · ${formatBytes(artifact.bytes)}`,
        element('span', 'ejm-table__hash', `SHA-256 ${artifact.sha256}`),
      );
      const download = element('a', 'ejm-button', 'Download');
      download.href = artifact.url;
      download.append(element('span', 'ejm-sr', ` for ${installer.name}`));
      action.append(download);
    } else {
      file.textContent = 'Installer not published yet';
      action.textContent = 'In development';
    }
    row.append(name, file, action);
    rows.append(row);
  }
}

function renderSource(sourceUrl?: string): void {
  sourceSlot.hidden = !sourceUrl;
  sourceSlot.replaceChildren();
  if (!sourceUrl) return;
  const link = element('a', undefined, 'Source');
  link.href = sourceUrl;
  link.rel = 'noopener noreferrer external';
  sourceSlot.append(link);
}

function renderReleases(state: ReleaseState): void {
  const manifest = state.status === 'ready' ? state.manifest : undefined;
  const anyRelease = (manifest?.artifacts.length ?? 0) > 0;
  heroLabel.textContent = anyRelease ? 'Download ejm-ide' : 'View downloads';
  heroStatus.textContent = anyRelease
    ? 'Installers are listed below'
    : 'Desktop releases in development';
  table.setAttribute('aria-busy', String(state.status === 'loading'));
  renderSource(manifest?.sourceUrl);
  renderRows(manifest);
  retry?.remove();
  retry = undefined;
  if (state.status === 'loading') {
    message.textContent = 'Checking available downloads…';
  } else if (state.status === 'error') {
    message.textContent = 'Downloads could not be loaded. Please try again.';
    retry = element('button', 'ejm-button ejm-button--secondary', 'Try again');
    retry.type = 'button';
    retry.addEventListener('click', () => {
      refreshReleases();
      // Loading removes this button, so return focus to the table region.
      table.focus();
    });
    status.append(retry);
  } else if (manifest && anyRelease) {
    const version = manifest.version ? `Version ${manifest.version}. ` : '';
    message.textContent = `${version}Free download. No ejmlabs account required.`;
  } else {
    message.textContent =
      'We’re preparing the first desktop release. The download will appear here when it’s ready.';
  }
}

function refreshReleases(): void {
  activeRequest?.abort();
  const controller = new AbortController();
  activeRequest = controller;
  renderReleases({ status: 'loading' });
  loadReleases(controller.signal).then(
    (manifest) => {
      if (!controller.signal.aborted) renderReleases({ status: 'ready', manifest });
    },
    () => {
      if (!controller.signal.aborted) renderReleases({ status: 'error' });
    },
  );
}

window.addEventListener('pagehide', () => activeRequest?.abort());
window.addEventListener('pageshow', (event) => {
  if (event.persisted) refreshReleases();
});
if (import.meta.hot) import.meta.hot.dispose(() => activeRequest?.abort());
refreshReleases();
