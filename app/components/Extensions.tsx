import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { convertFileSrc } from '@tauri-apps/api/core';
import {
  Check,
  ChevronDown,
  Code2,
  ExternalLink,
  Hammer,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  Power,
  Puzzle,
  RefreshCw,
  RotateCcw,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, isDesktop } from '@/lib/backend';
import {
  authoringPrompt,
  type ExtensionBundle,
  type ExtensionSummary,
  extensionContext,
  extensionDocument,
  extensionHostMessage,
  parseExtensionMessage,
} from '@/lib/extensions';
import type { ContextReference, SourceRange, Workspace } from '@/lib/types';
import { Button } from './ui/button';
import { Tooltip } from './ui/tooltip';
import './extensions.css';

export interface ExtensionPaletteCommand {
  id: string;
  label: string;
  run: () => void;
}
export interface ExtensionsProps {
  workspace: Workspace | null;
  context: ContextReference[];
  onAttach: (reference: ContextReference) => void;
  onNavigate: (uri: string, range?: SourceRange) => void;
  onOpenReference: (reference: ContextReference) => void;
  onBuildWithAgent: (prompt: string) => void;
  onCommandsChange?: (commands: ExtensionPaletteCommand[]) => void;
}

export function Extensions({
  workspace,
  context,
  onAttach,
  onNavigate,
  onOpenReference,
  onBuildWithAgent,
  onCommandsChange,
}: ExtensionsProps) {
  const [extensions, setExtensions] = useState<ExtensionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadedBundle, setLoadedBundle] = useState<{ root: string; value: ExtensionBundle } | null>(
    null,
  );
  const [version, setVersion] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mountedFrame, setMountedFrame] = useState<{ session: string; url: string } | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const root = workspace?.root;
  const currentRoot = useRef(root);
  currentRoot.current = root;
  const latest = useRef({ context, onAttach, onOpenReference });
  latest.current = { context, onAttach, onOpenReference };
  const selected = extensions.find((extension) => extension.id === selectedId);
  const chosenVersion = version || selected?.activeVersion;
  const bundle =
    loadedBundle &&
    loadedBundle.root === root &&
    loadedBundle.value.manifest.id === selectedId &&
    loadedBundle.value.version === chosenVersion
      ? loadedBundle.value
      : null;
  const { id: session, nonce } = useMemo(
    () => ({
      root,
      selectedId,
      chosenVersion,
      reload,
      id: crypto.randomUUID(),
      nonce: crypto.randomUUID(),
    }),
    [root, selectedId, chosenVersion, reload],
  );
  const frameUrl = mountedFrame?.session === session ? mountedFrame.url : null;
  const document = useMemo(
    () => (bundle ? extensionDocument(bundle, session, nonce) : ''),
    [bundle, session, nonce],
  );
  const isActive = !!bundle && selected?.activeVersion === bundle.version;

  const refresh = useCallback(async () => {
    if (!root) return [];
    const entries = await invoke<ExtensionSummary[]>('extensions_list');
    if (currentRoot.current !== root) return [];
    setExtensions(entries);
    setSelectedId((previous) =>
      entries.some((entry) => entry.id === previous) ? previous : entries[0]?.id || null,
    );
    return entries;
  }, [root]);

  useEffect(() => {
    let current = true;
    setExtensions([]);
    setSelectedId(null);
    setLoadedBundle(null);
    setVersion(null);
    setError(null);
    setNotice(null);
    setBusy(null);
    setMountedFrame(null);
    if (root)
      invoke<ExtensionSummary[]>('extensions_list')
        .then((entries) => {
          if (current) {
            setExtensions(entries);
            setSelectedId(entries[0]?.id || null);
          }
        })
        .catch((reason) => {
          if (current) setError(String(reason));
        });
    return () => {
      current = false;
    };
  }, [root]);

  useEffect(() => {
    let current = true;
    setLoadedBundle(null);
    if (root && selectedId && chosenVersion)
      invoke<ExtensionBundle>('extensions_panel', { id: selectedId, version: chosenVersion })
        .then((value) => {
          if (current) setLoadedBundle({ root, value });
        })
        .catch((reason) => {
          if (current) setError(String(reason));
        });
    return () => {
      current = false;
    };
  }, [root, selectedId, chosenVersion]);

  useEffect(() => {
    let closed = false;
    let token: string | undefined;
    setMountedFrame(null);
    if (bundle)
      invoke<string>('extensions_mount', { document, nonce })
        .then((value) => {
          token = value;
          if (closed) void invoke('extensions_unmount', { token }).catch(() => {});
          else setMountedFrame({ session, url: convertFileSrc(token, 'workbench-extension') });
        })
        .catch((reason) => {
          if (!closed) setError(String(reason));
        });
    return () => {
      closed = true;
      if (token) void invoke('extensions_unmount', { token }).catch(() => {});
    };
  }, [bundle, document, nonce, session]);

  const sendContext = useCallback(() => {
    if (!bundle) return;
    frame.current?.contentWindow?.postMessage(
      extensionHostMessage(
        session,
        'context',
        extensionContext(context, bundle.manifest.capabilities),
      ),
      '*',
    );
  }, [bundle, session, context]);

  useEffect(() => {
    sendContext();
  }, [sendContext]);

  useEffect(() => {
    if (!bundle) return;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null') return;
      const message = parseExtensionMessage(event.data, session, bundle.manifest.capabilities);
      if (!message) return;
      if (message.type === 'ready') {
        sendContext();
        return;
      }
      if ('referenceId' in message) {
        const reference = latest.current.context
          .slice(0, 12)
          .find((item) => item.id === message.referenceId);
        if (!reference) return;
        if (message.type === 'navigate') latest.current.onOpenReference(reference);
        if (message.type === 'attach')
          latest.current.onAttach({
            ...reference,
            id: crypto.randomUUID(),
            capturedAt: Date.now(),
          });
        return;
      }
      if (message.type === 'attach')
        latest.current.onAttach({
          id: crypto.randomUUID(),
          kind: 'extension',
          label: message.label,
          origin: bundle.manifest.name,
          content: message.content,
          capturedAt: Date.now(),
          version: bundle.version,
        });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [bundle, session, sendContext]);

  const runCommand = useCallback(
    (id: string) => {
      if (!bundle?.manifest.commands.some((command) => command.id === id)) return;
      frame.current?.contentWindow?.postMessage(extensionHostMessage(session, 'command', id), '*');
    },
    [bundle, session],
  );

  useEffect(() => {
    onCommandsChange?.(
      isActive && bundle
        ? bundle.manifest.commands.map((command) => ({
            id: `extension:${bundle.manifest.id}:${command.id}`,
            label: `${bundle.manifest.name}: ${command.title}`,
            run: () => runCommand(command.id),
          }))
        : [],
    );
    return () => onCommandsChange?.([]);
  }, [bundle, isActive, onCommandsChange, runCommand]);

  async function perform(label: string, action: () => Promise<void>) {
    if (busy) return;
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (reason) {
      if (currentRoot.current === root) setError(String(reason));
    } finally {
      if (currentRoot.current === root) setBusy(null);
    }
  }

  async function scaffold() {
    if (!isDesktop) return;
    const created = await invoke<ExtensionSummary>('extensions_scaffold');
    if (currentRoot.current !== root) return;
    await refresh();
    setSelectedId(created.id);
    setVersion(null);
    setNotice('Sample created. Build a preview or ask Edi to adapt it.');
    return created;
  }

  async function authorWithAgent(createNew = false) {
    const extension = !isDesktop
      ? createNew
        ? undefined
        : selected
      : createNew && extensions.length
        ? undefined
        : selected || (await scaffold());
    if (currentRoot.current === root) onBuildWithAgent(authoringPrompt(extension));
  }

  async function build() {
    if (!isDesktop || !root || !selectedId) return;
    const checked = await invoke<ExtensionBundle>('extensions_build', { id: selectedId });
    if (currentRoot.current !== root) return;
    await refresh();
    setVersion(checked.version);
    setLoadedBundle({ root, value: checked });
    setReload((value) => value + 1);
    setNotice(
      `Preview ready. ${selected?.activeVersion ? 'Your enabled version stays active until Reload.' : 'Review access, then enable when ready.'}`,
    );
  }

  async function activate() {
    if (!isDesktop || !bundle) return;
    await invoke<ExtensionSummary>('extensions_activate', {
      id: bundle.manifest.id,
      version: bundle.version,
    });
    if (currentRoot.current !== root) return;
    await refresh();
    setReload((value) => value + 1);
    setNotice('Extension enabled.');
  }

  async function disable() {
    if (!isDesktop || !selectedId) return;
    await invoke<ExtensionSummary>('extensions_disable', { id: selectedId });
    if (currentRoot.current !== root) return;
    await refresh();
    setLoadedBundle(null);
    setVersion(null);
    setNotice('Extension disabled.');
  }

  async function revert() {
    if (!isDesktop || !selectedId) return;
    const restored = await invoke<ExtensionSummary>('extensions_revert', { id: selectedId });
    if (currentRoot.current !== root) return;
    await refresh();
    setVersion(restored.activeVersion);
    setReload((value) => value + 1);
    setNotice('Previous checked version restored.');
  }

  if (!workspace)
    return (
      <div className="extensions-panel pane-empty">
        <Puzzle size={28} />
        <h3>Extensions</h3>
        <p>Open a project to build tools for your workflow.</p>
      </div>
    );

  const nativeRequiredTitle = !isDesktop ? 'Available in the desktop app' : undefined;
  const manifest = bundle?.manifest || selected?.manifest;
  const readyToEnable = !!bundle && !isActive;
  const enabledPreview = isActive || (!!selected?.activeVersion && !bundle);
  const loadingPreview = !!chosenVersion && !bundle && !error;
  const capabilityLabels = {
    'context.read': 'Read context shared with this panel',
    'chat.attach': 'Add references and notes to chat',
    'source.open': 'Open shared source references',
  };
  const openSource = () => {
    if (selected)
      onNavigate(
        `${workspace.root}/.workbench/extensions/${selected.id}/${selected.manifest?.entry || 'extension.json'}`,
      );
  };

  return (
    <section
      className="extensions-panel flex h-full min-h-0 flex-col"
      aria-label="Local extensions"
    >
      <header className="pane-heading flex items-center justify-between gap-2 border-b px-3 py-2">
        <span className="extension-heading-title">
          <Puzzle size={14} /> Extensions
        </span>
        <div className="extension-header-actions">
          <Tooltip label="Refresh extensions">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh extensions"
              disabled={!!busy}
              onClick={() =>
                void perform('refresh', async () => {
                  await refresh();
                })
              }
            >
              <RefreshCw size={13} />
            </Button>
          </Tooltip>
          <DropdownMenu.Root>
            <Tooltip label="Add extension">
              <DropdownMenu.Trigger asChild>
                <Button variant="ghost" size="icon" aria-label="Add extension" disabled={!!busy}>
                  <Plus size={14} />
                </Button>
              </DropdownMenu.Trigger>
            </Tooltip>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="dropdown-content extension-menu"
                align="end"
                sideOffset={5}
                collisionPadding={8}
              >
                <DropdownMenu.Item
                  className="dropdown-item"
                  onSelect={() =>
                    void perform('author', async () => {
                      await authorWithAgent(true);
                    })
                  }
                >
                  <Code2 size={13} /> Build with Edi
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className="dropdown-item"
                  disabled={
                    !isDesktop ||
                    extensions.some((extension) => extension.id === 'selection-notebook')
                  }
                  title={nativeRequiredTitle}
                  onSelect={() =>
                    void perform('create', async () => {
                      await scaffold();
                    })
                  }
                >
                  <Puzzle size={13} /> Try sample notebook
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </header>
      {!isDesktop && (
        <p className="extension-preview-note">
          Browser preview. Build and run extensions in the desktop app.
        </p>
      )}
      {selected ? (
        <>
          <div className="extension-toolbar">
            <div className="extension-identity">
              {extensions.length > 1 ? (
                <select
                  className="extension-select"
                  aria-label="Extension"
                  value={selectedId || ''}
                  disabled={!!busy}
                  onChange={(event) => {
                    setSelectedId(event.target.value);
                    setVersion(null);
                    setNotice(null);
                    setError(null);
                  }}
                >
                  {extensions.map((extension) => (
                    <option key={extension.id} value={extension.id}>
                      {extension.manifest?.name || extension.id}
                      {extension.activeVersion ? ' (enabled)' : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <h3>{selected.manifest?.name || selected.id}</h3>
              )}
              <span className="extension-state" data-active={enabledPreview}>
                {enabledPreview ? 'Enabled' : bundle ? 'Draft preview' : 'Not enabled'}
              </span>
            </div>
            {selected.manifest?.description && (
              <p className="extension-description">{selected.manifest.description}</p>
            )}
            <div className="extension-next-action">
              <Button
                size="sm"
                disabled={!isDesktop || !!busy || loadingPreview}
                title={nativeRequiredTitle}
                onClick={() =>
                  void perform(readyToEnable ? 'enable' : 'build', readyToEnable ? activate : build)
                }
              >
                {busy || loadingPreview ? (
                  <LoaderCircle size={12} className="animate-spin" />
                ) : readyToEnable ? (
                  <Check size={12} />
                ) : (
                  <Hammer size={12} />
                )}
                {loadingPreview
                  ? 'Loading preview…'
                  : busy === 'build'
                    ? 'Building…'
                    : busy === 'enable'
                      ? 'Enabling…'
                      : readyToEnable
                        ? selected.activeVersion
                          ? 'Reload extension'
                          : 'Enable extension'
                        : 'Build preview'}
              </Button>
              <DropdownMenu.Root>
                <Tooltip label="Extension actions">
                  <DropdownMenu.Trigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Extension actions"
                      disabled={!!busy}
                    >
                      <MoreHorizontal size={16} />
                    </Button>
                  </DropdownMenu.Trigger>
                </Tooltip>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    className="dropdown-content extension-menu"
                    align="start"
                    sideOffset={5}
                    collisionPadding={8}
                  >
                    <DropdownMenu.Item className="dropdown-item" onSelect={openSource}>
                      <Code2 size={13} /> Open source
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      className="dropdown-item"
                      onSelect={() =>
                        void perform('author', async () => {
                          await authorWithAgent();
                        })
                      }
                    >
                      <Code2 size={13} /> Edit with Edi
                    </DropdownMenu.Item>
                    {readyToEnable && (
                      <DropdownMenu.Item
                        className="dropdown-item"
                        disabled={!isDesktop}
                        title={nativeRequiredTitle}
                        onSelect={() => void perform('build', build)}
                      >
                        <Hammer size={13} /> Rebuild preview
                      </DropdownMenu.Item>
                    )}
                    {isActive && (
                      <DropdownMenu.Item
                        className="dropdown-item"
                        disabled={!isDesktop}
                        title={nativeRequiredTitle}
                        onSelect={() => void perform('enable', activate)}
                      >
                        <RefreshCw size={13} /> Reload panel
                      </DropdownMenu.Item>
                    )}
                    <DropdownMenu.Separator className="dropdown-separator" />
                    <DropdownMenu.Item
                      className="dropdown-item"
                      disabled={!isDesktop || !selected.previousVersion}
                      title={nativeRequiredTitle}
                      onSelect={() => void perform('revert', revert)}
                    >
                      <RotateCcw size={13} /> Restore previous version
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      className="dropdown-item"
                      disabled={!isDesktop || !selected.activeVersion}
                      title={nativeRequiredTitle}
                      onSelect={() => void perform('disable', disable)}
                    >
                      <Power size={13} /> Disable extension
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
            <details
              className="extension-details"
              key={`${selected.id}:${bundle?.version || 'source'}`}
              open={readyToEnable}
            >
              <summary>
                <ChevronDown size={12} aria-hidden="true" />
                {readyToEnable ? 'Review access' : 'Extension details'}
              </summary>
              <div className="extension-details-body">
                <ul className="extension-capabilities">
                  {manifest?.capabilities.length ? (
                    manifest.capabilities.map((capability) => (
                      <li key={capability}>{capabilityLabels[capability]}</li>
                    ))
                  ) : (
                    <li>No host access requested</li>
                  )}
                </ul>
                <p className="extension-sandbox">Local sandbox. No network or shell access.</p>
                {bundle && (
                  <dl className="extension-version">
                    <dt>Version</dt>
                    <dd title={bundle.version}>
                      <code>{bundle.version.slice(0, 10)}</code>
                    </dd>
                  </dl>
                )}
                {!!manifest?.commands.length && (
                  <div className="extension-commands">
                    <p>Commands</p>
                    {manifest.commands.map((command) => (
                      <Button
                        key={command.id}
                        size="sm"
                        variant="ghost"
                        disabled={!!busy || !frameUrl}
                        onClick={() => runCommand(command.id)}
                      >
                        {command.title}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            </details>
          </div>
          {(error || selected.error) && (
            <p role="alert" className="extension-error">
              {error || selected.error}
            </p>
          )}
          {notice && (
            <p role="status" className="extension-notice">
              {notice}
            </p>
          )}
          {bundle && frameUrl ? (
            <iframe
              key={session}
              ref={frame}
              className="min-h-0 w-full flex-1 border-0 bg-[var(--ejm-ui-n2)]"
              title={`${bundle.manifest.name} ${isActive ? 'panel' : 'preview'}`}
              sandbox="allow-scripts"
              allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
              referrerPolicy="no-referrer"
              src={frameUrl}
              onLoad={sendContext}
            />
          ) : (
            <div className="pane-empty extension-empty">
              <Puzzle size={24} />
              <p>
                {loadingPreview ? 'Loading extension…' : 'Build a preview to try this extension.'}
              </p>
              <button
                type="button"
                className="extension-authoring-link"
                onClick={() =>
                  onNavigate(`${workspace.root}/.workbench/extensions/${selected.id}/SKILL.md`)
                }
              >
                Authoring guide <ExternalLink size={11} />
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="pane-empty extension-empty">
          <Puzzle size={28} />
          <h3>Build a tool for your workflow</h3>
          <p>Ask Edi to build a local panel, or start with a sample notebook.</p>
          <Button
            size="sm"
            disabled={!!busy}
            onClick={() =>
              void perform('author', async () => {
                await authorWithAgent();
              })
            }
          >
            {busy === 'author' ? (
              <LoaderCircle size={13} className="animate-spin" />
            ) : (
              <Code2 size={13} />
            )}
            Build with Edi
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!isDesktop || !!busy}
            title={nativeRequiredTitle}
            onClick={() =>
              void perform('create', async () => {
                await scaffold();
              })
            }
          >
            Try sample notebook
          </Button>
          {error && (
            <p role="alert" className="extension-error">
              {error}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
