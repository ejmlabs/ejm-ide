import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  LogIn,
  LogOut,
  Plus,
  Sparkles,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { invoke, isDesktop, onEvent } from '@/lib/backend';
import {
  listProviders,
  loadProviderAuthStatus,
  MAX_OUTPUT_TOKENS,
  MIN_OUTPUT_TOKENS,
  type ProviderAuthFlow,
  type ProviderAuthStatus,
  type ProviderProfile,
  type ProviderProtocol,
  type ProviderReasoning,
  parseProviderModels,
  pendingProviderAuth,
  providerRegistrationLabel,
  providerRegistrationState,
  validateProviderProfile,
} from '@/lib/providers';
import { Button } from './ui/button';
import { Tooltip } from './ui/tooltip';
import './provider-settings.css';

type ConnectionMethod = 'codex' | 'anthropic' | 'apiKey';
type ConnectionView = 'connections' | 'method' | 'apiFormat' | 'anthropic' | 'editor';
export interface ConnectionDraft {
  profile: ProviderProfile;
  modelText: string;
  apiKey: string;
  clearKey: boolean;
  credentialMode: 'apiKey' | 'chatgpt';
}

const endpoints: Record<ProviderProtocol, string> = {
  openaiCompatible: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
};

function newProfile(): ProviderProfile {
  return {
    id: crypto.randomUUID(),
    name: '',
    protocol: 'openaiCompatible',
    endpoint: endpoints.openaiCompatible,
    models: [],
    reasoning: 'none',
    maxOutputTokens: 4096,
    apiKeyEnv: null,
    hasKey: false,
  };
}

function profileDraft(profile: ProviderProfile): ConnectionDraft {
  return {
    profile: { ...profile },
    modelText: profile.models.join('\n'),
    apiKey: '',
    clearKey: false,
    credentialMode: profile.chatgptRegistrationId ? 'chatgpt' : 'apiKey',
  };
}

// These transitions are ejm-ide's connection policy. Auth and key storage stay native.
export function changeConnectionMethod(
  draft: ConnectionDraft,
  method: 'codex' | 'apiKey',
  protocol: ProviderProtocol = 'openaiCompatible',
  previousMethodDraft?: ConnectionDraft,
): ConnectionDraft {
  const targetMode = method === 'codex' ? 'chatgpt' : 'apiKey';
  const switching =
    draft.credentialMode !== targetMode ||
    (targetMode === 'apiKey' && draft.profile.protocol !== protocol);
  const remembered =
    switching &&
    previousMethodDraft?.profile.id === draft.profile.id &&
    previousMethodDraft.credentialMode === targetMode &&
    (targetMode === 'chatgpt' || previousMethodDraft.profile.protocol === protocol)
      ? previousMethodDraft
      : undefined;
  const source = remembered
    ? { ...remembered, profile: { ...remembered.profile, hasKey: draft.profile.hasKey } }
    : draft;
  if (method === 'codex') {
    return {
      ...source,
      profile: {
        ...source.profile,
        name: source.profile.name.trim() || 'Codex',
        protocol: 'openaiCompatible',
        endpoint: endpoints.openaiCompatible,
        reasoning: remembered ? source.profile.reasoning : 'openai',
        apiKeyEnv: null,
      },
      apiKey: '',
      clearKey: draft.clearKey || draft.profile.hasKey,
      credentialMode: 'chatgpt',
    };
  }
  const changedProtocol = draft.profile.protocol !== protocol;
  return {
    ...source,
    profile: {
      ...source.profile,
      name: source.profile.name.trim() || (protocol === 'anthropic' ? 'Anthropic' : 'OpenAI'),
      protocol,
      endpoint: remembered || !switching ? source.profile.endpoint : endpoints[protocol],
      reasoning: remembered || !switching ? source.profile.reasoning : 'none',
      apiKeyEnv: remembered || !switching ? source.profile.apiKeyEnv : null,
      chatgptRegistrationId: null,
    },
    apiKey: switching ? '' : source.apiKey,
    clearKey: draft.clearKey || source.clearKey || (changedProtocol && draft.profile.hasKey),
    credentialMode: 'apiKey',
  };
}

function methodDraftKey(draft: ConnectionDraft): string {
  return `${draft.profile.id}:${draft.credentialMode}:${draft.credentialMode === 'apiKey' ? draft.profile.protocol : ''}`;
}

const authFlowMessages: Record<ProviderAuthFlow['phase'], string> = {
  starting: 'Opening browser sign-in…',
  waiting: 'Finish signing in in your browser.',
  completing: 'Completing sign-in…',
  retrying: 'Retrying sign-in in your browser…',
  succeeded: 'Signed in. Choose your account to connect.',
  cancelled: 'Sign-in cancelled.',
  expired: 'Sign-in expired. Try again.',
  failed: 'Sign-in failed. Try again.',
};

export function ProviderConnectionChoices({
  onChoose,
  disabled = false,
}: {
  onChoose: (method: ConnectionMethod) => void;
  disabled?: boolean;
}) {
  return (
    <section className="provider-choices" aria-label="Connection method">
      <button
        type="button"
        data-provider-autofocus
        disabled={disabled}
        onClick={() => onChoose('codex')}
      >
        <Terminal size={19} aria-hidden="true" />
        <span>
          <strong>Codex</strong>
          <small>Sign in with your ChatGPT subscription</small>
        </span>
        <ChevronRight size={15} aria-hidden="true" />
      </button>
      <button type="button" disabled={disabled} onClick={() => onChoose('anthropic')}>
        <Sparkles size={19} aria-hidden="true" />
        <span>
          <strong>Anthropic</strong>
          <small>Claude subscription</small>
        </span>
        <span className="provider-choice-status">Unavailable</span>
        <ChevronRight size={15} aria-hidden="true" />
      </button>
      <button type="button" disabled={disabled} onClick={() => onChoose('apiKey')}>
        <KeyRound size={19} aria-hidden="true" />
        <span>
          <strong>API key</strong>
          <small>OpenAI, Anthropic, other providers, or local models</small>
        </span>
        <ChevronRight size={15} aria-hidden="true" />
      </button>
    </section>
  );
}

export function ProviderApiFormatChoices({
  onChoose,
  disabled = false,
}: {
  onChoose: (protocol: ProviderProtocol) => void;
  disabled?: boolean;
}) {
  return (
    <section className="provider-choices" aria-label="API format">
      <button
        type="button"
        data-provider-autofocus
        disabled={disabled}
        onClick={() => onChoose('openaiCompatible')}
      >
        <Terminal size={19} aria-hidden="true" />
        <span>
          <strong>OpenAI-compatible</strong>
          <small>OpenAI, OpenRouter, DeepSeek, Ollama, and more</small>
        </span>
        <ChevronRight size={15} aria-hidden="true" />
      </button>
      <button type="button" disabled={disabled} onClick={() => onChoose('anthropic')}>
        <Sparkles size={19} aria-hidden="true" />
        <span>
          <strong>Anthropic-compatible</strong>
          <small>Anthropic or a provider that uses the Messages API</small>
        </span>
        <ChevronRight size={15} aria-hidden="true" />
      </button>
    </section>
  );
}

export function ProviderPendingSignIn({
  flow,
  working,
  available = isDesktop,
  onCancel,
}: {
  flow?: ProviderAuthFlow | null;
  working: boolean;
  available?: boolean;
  onCancel: (flowId: string) => void;
}) {
  if (!flow || !pendingProviderAuth(flow)) return null;
  return (
    <section className="provider-pending-sign-in" aria-label="ChatGPT sign-in in progress">
      <div>
        <strong>ChatGPT sign-in in progress</strong>
        <p role="status">
          <LoaderCircle size={12} className="spin" aria-hidden="true" />
          {authFlowMessages[flow.phase]}
        </p>
      </div>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={working || !available}
        onClick={() => onCancel(flow.flowId)}
      >
        Cancel sign-in
      </Button>
    </section>
  );
}

export function ProviderAccountControls({
  status,
  registrationId,
  loading,
  working,
  available = isDesktop,
  onSelect,
  onSignIn,
  onCancel,
  onSignOut,
}: {
  status: ProviderAuthStatus | null;
  registrationId: string;
  loading: boolean;
  working: boolean;
  available?: boolean;
  onSelect: (registrationId: string) => void;
  onSignIn: (registrationId?: string) => void;
  onCancel: (flowId: string) => void;
  onSignOut: (registrationId: string) => void;
}) {
  const account = status?.registrations.find((item) => item.id === registrationId);
  const flow = status?.flow;
  const pending = pendingProviderAuth(flow);
  const unavailableAccount = !!registrationId && !!status && !account;
  const ready = !!account?.signed_in && account.plan_enabled;
  return (
    <section className="provider-account-controls" aria-label="ChatGPT subscription">
      {(loading || !!status?.registrations.length || !!registrationId) && (
        <label>
          ChatGPT account
          <select
            data-provider-autofocus
            value={registrationId}
            disabled={working || pending || loading || !available}
            onChange={(event) => onSelect(event.target.value)}
          >
            <option value="">{loading ? 'Loading accounts…' : 'Choose an account…'}</option>
            {unavailableAccount && (
              <option value={registrationId}>Saved account unavailable</option>
            )}
            {status?.registrations.map((registration) => (
              <option key={registration.id} value={registration.id}>
                {providerRegistrationLabel(registration)} ·{' '}
                {providerRegistrationState(registration)}
              </option>
            ))}
          </select>
        </label>
      )}
      {account && (
        <p className="provider-account-state" role="status">
          {ready && <Check size={13} aria-hidden="true" />}
          {providerRegistrationState(account)}
          {account.signed_in && !account.plan_enabled && '. Sign in again to grant model access.'}
        </p>
      )}
      {unavailableAccount && (
        <p className="provider-account-state" role="status">
          This account is unavailable. Sign in or choose another account.
        </p>
      )}
      {pending && flow ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={working || !available}
          onClick={() => onCancel(flow.flowId)}
        >
          Cancel sign-in
        </Button>
      ) : (
        <>
          {!ready && (
            <Button
              type="button"
              className="provider-sign-in"
              data-provider-autofocus
              disabled={working || loading || !available}
              onClick={() => onSignIn(account?.id)}
            >
              <LogIn size={13} />
              {account?.signed_in ? 'Sign in again' : 'Sign in with ChatGPT'}
            </Button>
          )}
          {!!status?.registrations.length && (
            <details className="provider-account-options">
              <summary>
                <ChevronRight size={12} aria-hidden="true" />
                Account options
              </summary>
              <div className="provider-account-actions">
                {ready && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={working || loading || !available}
                    onClick={() => onSignIn(account.id)}
                  >
                    <LogIn size={12} />
                    Sign in again
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={working || loading || !available}
                  onClick={() => onSignIn()}
                >
                  <Plus size={12} />
                  Add account
                </Button>
                {account?.signed_in && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={working || !available}
                    onClick={() => onSignOut(account.id)}
                  >
                    <LogOut size={12} />
                    Sign out
                  </Button>
                )}
              </div>
            </details>
          )}
        </>
      )}
      {flow && (
        <p className="provider-auth-flow" role="status">
          {pending && <LoaderCircle size={12} className="spin" aria-hidden="true" />}
          <span>
            {authFlowMessages[flow.phase]}
            {pending &&
              flow.expiresAt > 0 &&
              ` Expires at ${new Date(flow.expiresAt * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`}
          </span>
        </p>
      )}
      {flow?.error && (
        <p className="error-text" role="alert">
          {flow.error}
        </p>
      )}
    </section>
  );
}

export function ProviderConnectionFields({
  connection,
  working,
  onChange,
}: {
  connection: ConnectionDraft;
  working: boolean;
  onChange: (connection: ConnectionDraft) => void;
}) {
  const { profile, apiKey, clearKey, modelText, credentialMode } = connection;
  const api = credentialMode === 'apiKey';
  const patchProfile = (patch: Partial<ProviderProfile>) =>
    onChange({
      ...connection,
      apiKey: patch.apiKeyEnv?.trim() ? '' : connection.apiKey,
      profile: { ...profile, ...patch },
    });
  return (
    <>
      {api && (
        <>
          {profile.apiKeyEnv ? (
            <div className="provider-key-source">
              <span>
                <KeyRound size={14} aria-hidden="true" />
                Key from <code>{profile.apiKeyEnv}</code>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={working}
                onClick={() => patchProfile({ apiKeyEnv: null })}
              >
                Use a saved key
              </Button>
            </div>
          ) : (
            <label>
              API key
              <input
                type="password"
                data-provider-autofocus
                autoComplete="new-password"
                value={apiKey}
                placeholder={
                  profile.hasKey && !clearKey ? 'Saved in your keychain' : 'Paste your API key'
                }
                disabled={working || !isDesktop}
                onChange={(event) =>
                  onChange({ ...connection, apiKey: event.target.value, clearKey: false })
                }
              />
              <small>
                {profile.hasKey && !clearKey
                  ? 'Leave blank to keep the saved key.'
                  : clearKey
                    ? 'The saved key will be removed. Enter a new key to replace it.'
                    : 'Stored in your system keychain. Optional for local models.'}
              </small>
            </label>
          )}
          <label>
            API URL
            <input
              value={profile.endpoint}
              data-provider-autofocus
              placeholder="https://api.example.com/v1"
              spellCheck={false}
              disabled={working}
              onChange={(event) => patchProfile({ endpoint: event.target.value })}
            />
          </label>
        </>
      )}
      <details className="provider-advanced">
        <summary>
          <ChevronRight size={13} aria-hidden="true" />
          Advanced
        </summary>
        <div className="provider-advanced-fields">
          <label>
            Connection name
            <input
              value={profile.name}
              placeholder="My provider"
              disabled={working}
              onChange={(event) => patchProfile({ name: event.target.value })}
            />
          </label>
          {api && (
            <>
              <label>
                Key environment variable
                <input
                  value={profile.apiKeyEnv || ''}
                  placeholder={
                    profile.protocol === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'
                  }
                  spellCheck={false}
                  disabled={working}
                  onChange={(event) => patchProfile({ apiKeyEnv: event.target.value })}
                />
                <small>
                  Optional alternative to a saved key. Available to the desktop process.
                </small>
              </label>
              {profile.hasKey && (
                <label className="provider-clear-key">
                  <input
                    type="checkbox"
                    checked={clearKey}
                    disabled={working}
                    onChange={(event) =>
                      onChange({ ...connection, clearKey: event.target.checked, apiKey: '' })
                    }
                  />
                  Remove saved key on save
                </label>
              )}
            </>
          )}
          <label>
            Model IDs
            <textarea
              value={modelText}
              rows={3}
              placeholder="One per line, or separated by commas"
              spellCheck={false}
              disabled={working}
              onChange={(event) => onChange({ ...connection, modelText: event.target.value })}
            />
            <small>Optional fallback if your provider cannot list models.</small>
          </label>
          <div className="provider-form-row">
            <label>
              Output token limit
              <input
                type="number"
                min={MIN_OUTPUT_TOKENS}
                max={MAX_OUTPUT_TOKENS}
                value={profile.maxOutputTokens}
                disabled={working}
                onChange={(event) => patchProfile({ maxOutputTokens: Number(event.target.value) })}
              />
            </label>
            <label>
              Reasoning format
              <select
                value={profile.reasoning}
                disabled={working}
                onChange={(event) =>
                  patchProfile({ reasoning: event.target.value as ProviderReasoning })
                }
              >
                <option value="none">Off</option>
                {profile.protocol === 'openaiCompatible' ? (
                  <option value="openai">OpenAI effort</option>
                ) : (
                  <option value="anthropic">Anthropic thinking</option>
                )}
              </select>
            </label>
          </div>
          <p className="provider-form-note">Enable reasoning only if your model supports it.</p>
        </div>
      </details>
    </>
  );
}

export function ProviderSettings({
  open,
  onOpenChange,
  profiles: suppliedProfiles,
  activeProviderId,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profiles: ProviderProfile[];
  activeProviderId: string;
  onChanged: (providerId?: string) => Promise<void>;
}) {
  const [profiles, setProfiles] = useState(suppliedProfiles);
  const [connection, setConnection] = useState<ConnectionDraft>(() => profileDraft(newProfile()));
  const [view, setView] = useState<ConnectionView>('method');
  const [authStatus, setAuthStatus] = useState<ProviderAuthStatus | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authNotice, setAuthNotice] = useState('');
  const [revocationUnconfirmed, setRevocationUnconfirmed] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const refreshOnClose = useRef(false);
  const opened = useRef(false);
  const draftSlot = useRef('');
  const drafts = useRef(new Map<string, ConnectionDraft>());
  const methodDrafts = useRef(new Map<string, ConnectionDraft>());
  const formId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { profile: draft, credentialMode, clearKey, apiKey, modelText } = connection;
  const existing = profiles.some((profile) => profile.id === draft.id);
  const authPending = pendingProviderAuth(authStatus?.flow);
  const account = authStatus?.registrations.find((item) => item.id === draft.chatgptRegistrationId);
  const accountReady = !!account?.signed_in && account.plan_enabled;
  const remember = () => {
    if (view !== 'editor' || !draftSlot.current) return;
    drafts.current.set(draftSlot.current, connection);
    if (existing) {
      methodDrafts.current.set(methodDraftKey(connection), { ...connection, apiKey: '' });
    }
  };
  const resetNotices = useCallback(() => {
    setAuthError('');
    setAuthNotice('');
    setRevocationUnconfirmed(false);
    setError('');
  }, []);
  useEffect(() => {
    setProfiles(suppliedProfiles);
    if (!open) {
      opened.current = false;
      drafts.current.clear();
      methodDrafts.current.clear();
      draftSlot.current = '';
      setConnection(profileDraft(newProfile()));
      return;
    }
    // Provider refreshes must not replace a form the user is editing.
    if (opened.current) return;
    opened.current = true;
    setView(suppliedProfiles.length ? 'connections' : 'method');
    resetNotices();
  }, [open, suppliedProfiles, resetNotices]);
  useEffect(() => {
    if (!open || !isDesktop) {
      if (!isDesktop) setAuthStatus({ registrations: [] });
      return;
    }
    let current = true;
    let receivedEvent = false;
    let unsubscribe: (() => void) | undefined;
    setAuthLoading(true);
    setAuthError('');
    void loadProviderAuthStatus()
      .then((status) => {
        if (current && !receivedEvent) setAuthStatus(status);
      })
      .catch((reason) => {
        if (current) setAuthError(`Accounts could not load. ${String(reason)}`);
      })
      .finally(() => {
        if (current) setAuthLoading(false);
      });
    void onEvent<ProviderAuthStatus>('provider:auth', (status) => {
      if (!current) return;
      receivedEvent = true;
      setAuthStatus(status);
      setAuthLoading(false);
      if (status.flow?.phase === 'succeeded') refreshOnClose.current = true;
    })
      .then((off) => {
        if (current) unsubscribe = off;
        else off();
      })
      .catch((reason) => {
        if (current) setAuthError(`Account status updates are unavailable. ${String(reason)}`);
      });
    return () => {
      current = false;
      unsubscribe?.();
    };
  }, [open]);

  function select(profile: ProviderProfile) {
    remember();
    draftSlot.current = profile.id;
    setConnection(drafts.current.get(profile.id) || profileDraft(profile));
    resetNotices();
    setView('editor');
  }
  function add() {
    remember();
    draftSlot.current = '';
    setConnection(profileDraft(newProfile()));
    resetNotices();
    setView('method');
  }
  function chooseMethod(method: ConnectionMethod) {
    if (working || authPending) return;
    resetNotices();
    if (method === 'apiKey') {
      setView('apiFormat');
      return;
    }
    if (method === 'anthropic') {
      setView('anthropic');
      return;
    }
    const slot = existing ? draft.id : 'new:codex';
    draftSlot.current = slot;
    const next = existing
      ? changeConnectionMethod(
          connection,
          'codex',
          'openaiCompatible',
          methodDrafts.current.get(`${draft.id}:chatgpt:`),
        )
      : drafts.current.get(slot) || changeConnectionMethod(profileDraft(newProfile()), 'codex');
    drafts.current.set(slot, next);
    setConnection(next);
    setView('editor');
  }
  function chooseProtocol(protocol: ProviderProtocol) {
    if (working || authPending) return;
    const slot = existing ? draft.id : `new:apiKey:${protocol}`;
    draftSlot.current = slot;
    const next = existing
      ? changeConnectionMethod(
          connection,
          'apiKey',
          protocol,
          methodDrafts.current.get(`${draft.id}:apiKey:${protocol}`),
        )
      : drafts.current.get(slot) ||
        changeConnectionMethod(profileDraft(newProfile()), 'apiKey', protocol);
    drafts.current.set(slot, next);
    setConnection(next);
    resetNotices();
    setView('editor');
  }
  function back() {
    if (working || authPending) return;
    remember();
    setError('');
    if (view === 'editor') {
      setView(existing ? 'connections' : credentialMode === 'apiKey' ? 'apiFormat' : 'method');
    } else if (view === 'apiFormat' || view === 'anthropic') {
      setView('method');
    } else {
      setView('connections');
    }
  }
  async function accountAction(
    pendingNotice: string,
    action: () => Promise<void>,
  ): Promise<boolean> {
    if (working || !isDesktop) return false;
    setWorking(true);
    setAuthError('');
    setAuthNotice(pendingNotice);
    setRevocationUnconfirmed(false);
    try {
      await action();
      refreshOnClose.current = true;
      setAuthStatus(await loadProviderAuthStatus());
      setAuthNotice((current) => (current === pendingNotice ? '' : current));
      return true;
    } catch (reason) {
      setAuthNotice((current) => (current === pendingNotice ? '' : current));
      setAuthError(String(reason));
      return false;
    } finally {
      setWorking(false);
    }
  }
  function signIn(registrationId?: string) {
    return accountAction('Starting sign-in…', async () => {
      const flow = await invoke<ProviderAuthFlow>('provider_auth_start', { registrationId });
      setAuthStatus((current) => ({ registrations: current?.registrations || [], flow }));
    });
  }
  function cancelSignIn(flowId: string) {
    return accountAction('Cancelling sign-in…', async () => {
      await invoke('provider_auth_cancel', { flowId });
    });
  }
  function signOut(registrationId: string) {
    return accountAction('Signing out…', async () => {
      const result = await invoke<{ remote_revoked: boolean }>('provider_auth_logout', {
        registrationId,
      });
      setRevocationUnconfirmed(!result.remote_revoked);
      setAuthNotice(
        result.remote_revoked
          ? 'Signed out.'
          : 'Signed out locally. Remote disconnect could not be confirmed. Manage app access in ChatGPT Settings.',
      );
    });
  }
  async function refreshAfterFailure(reason: unknown) {
    refreshOnClose.current = true;
    let message = String(reason);
    try {
      setProfiles(await listProviders());
    } catch (refreshError) {
      message += ` The connection list could not refresh. ${String(refreshError)}`;
    }
    setError(message);
  }
  async function close() {
    if (working) return;
    if (authPending && authStatus?.flow && !(await cancelSignIn(authStatus.flow.flowId))) return;
    if (refreshOnClose.current) {
      setWorking(true);
      try {
        await onChanged();
        refreshOnClose.current = false;
      } catch (reason) {
        setError(
          (current) => `${current} The connection list could not refresh. ${String(reason)}`,
        );
        return;
      } finally {
        setWorking(false);
      }
    }
    drafts.current.clear();
    methodDrafts.current.clear();
    setConnection(profileDraft(newProfile()));
    onOpenChange(false);
  }
  async function save() {
    if (working || authPending || !isDesktop) return;
    if (credentialMode === 'chatgpt' && !accountReady) {
      setError('Choose a signed-in ChatGPT account with subscription access.');
      return;
    }
    const { hasKey: _hasKey, ...profile } = {
      ...draft,
      name: draft.name.trim(),
      endpoint: draft.endpoint.trim(),
      models: parseProviderModels(modelText),
      apiKeyEnv: credentialMode === 'apiKey' ? draft.apiKeyEnv?.trim() || null : null,
      chatgptRegistrationId:
        credentialMode === 'chatgpt' ? draft.chatgptRegistrationId || null : null,
    };
    const invalid = validateProviderProfile(profile, { apiKey, hasKey: draft.hasKey, clearKey });
    if (invalid) {
      setError(invalid);
      return;
    }
    setWorking(true);
    setError('');
    try {
      const saved = await invoke<ProviderProfile>('provider_save', {
        profile,
        apiKey: credentialMode === 'apiKey' ? apiKey.trim() || null : null,
        clearKey,
      });
      setConnection(profileDraft(saved));
      drafts.current.delete(draftSlot.current);
      await onChanged(saved.id);
      refreshOnClose.current = false;
      drafts.current.clear();
      methodDrafts.current.clear();
      onOpenChange(false);
    } catch (reason) {
      await refreshAfterFailure(reason);
    } finally {
      setWorking(false);
    }
  }
  async function remove() {
    if (working || authPending || !existing || !isDesktop) return;
    setWorking(true);
    setError('');
    try {
      await invoke('provider_remove', { providerId: draft.id });
      const remaining = profiles.filter((profile) => profile.id !== draft.id);
      setProfiles(remaining);
      drafts.current.delete(draftSlot.current);
      draftSlot.current = '';
      setConnection(profileDraft(newProfile()));
      setView(remaining.length ? 'connections' : 'method');
      await onChanged();
      refreshOnClose.current = false;
    } catch (reason) {
      await refreshAfterFailure(reason);
    } finally {
      setWorking(false);
    }
  }
  const codex = credentialMode === 'chatgpt';
  const title =
    view === 'connections'
      ? 'Model connections'
      : view === 'method'
        ? 'Connect a model'
        : view === 'apiFormat'
          ? 'Use an API key'
          : view === 'anthropic'
            ? 'Anthropic'
            : codex
              ? 'Codex'
              : draft.protocol === 'anthropic'
                ? 'Anthropic-compatible API'
                : 'OpenAI-compatible API';
  const description =
    view === 'connections'
      ? 'Manage your accounts and API endpoints.'
      : view === 'method'
        ? 'Choose how you want to connect.'
        : view === 'apiFormat'
          ? 'Which API does your provider support?'
          : view === 'anthropic'
            ? 'Claude subscription sign-in is unavailable in this build.'
            : codex
              ? 'Use your ChatGPT subscription. Sign-in opens in your browser.'
              : 'Your key stays in the system keychain.';
  const canGoBack = view !== 'connections' && (view !== 'method' || profiles.length > 0);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) void close();
        else if (!working) onOpenChange(value);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          key={view}
          ref={contentRef}
          className="dialog-content provider-dialog"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            const target = contentRef.current?.querySelector<HTMLElement>(
              '[data-provider-autofocus]:not(:disabled)',
            );
            (target || headingRef.current)?.focus();
          }}
          onEscapeKeyDown={(event) => {
            if (working) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (working) event.preventDefault();
          }}
        >
          <div className="dialog-heading provider-heading">
            {canGoBack && (
              <Tooltip label="Back">
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={working || authPending}
                  aria-label="Back"
                  onClick={back}
                >
                  <ArrowLeft size={16} />
                </Button>
              </Tooltip>
            )}
            <div>
              <Dialog.Title ref={headingRef} tabIndex={-1}>
                {title}
              </Dialog.Title>
              <Dialog.Description>{description}</Dialog.Description>
            </div>
            <Tooltip label="Close connections">
              <Dialog.Close asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={working}
                  aria-label="Close provider settings"
                >
                  <X size={16} />
                </Button>
              </Dialog.Close>
            </Tooltip>
          </div>
          <div className="provider-settings-body">
            {!isDesktop && (
              <p className="provider-preview-note">
                Browser preview. Use the desktop app to connect an account or save a key.
              </p>
            )}
            {!(view === 'editor' && codex) && (
              <>
                <ProviderPendingSignIn
                  flow={authStatus?.flow}
                  working={working}
                  onCancel={(id) => void cancelSignIn(id)}
                />
                {authStatus?.flow && authError && (
                  <p className="error-text" role="alert">
                    {authError}
                  </p>
                )}
              </>
            )}
            {view === 'connections' && (
              <nav className="provider-connections" aria-label="Configured providers">
                {profiles.map((profile) => (
                  <button
                    type="button"
                    key={profile.id}
                    data-provider-autofocus
                    disabled={working || authPending}
                    onClick={() => select(profile)}
                  >
                    {profile.chatgptRegistrationId ? (
                      <Terminal size={17} aria-hidden="true" />
                    ) : (
                      <KeyRound size={17} aria-hidden="true" />
                    )}
                    <span>
                      <strong>{profile.name}</strong>
                      <small>
                        {profile.chatgptRegistrationId
                          ? 'ChatGPT subscription'
                          : profile.protocol === 'anthropic'
                            ? 'Anthropic-compatible API'
                            : 'OpenAI-compatible API'}
                      </small>
                    </span>
                    {profile.id === activeProviderId && (
                      <span className="provider-active-label">
                        <Check size={12} aria-hidden="true" />
                        In use
                      </span>
                    )}
                    <ChevronRight size={14} aria-hidden="true" />
                  </button>
                ))}
              </nav>
            )}
            {view === 'method' && (
              <ProviderConnectionChoices
                onChoose={chooseMethod}
                disabled={working || authPending}
              />
            )}
            {view === 'apiFormat' && (
              <ProviderApiFormatChoices
                onChoose={chooseProtocol}
                disabled={working || authPending}
              />
            )}
            {view === 'anthropic' && (
              <div className="provider-unavailable">
                <Sparkles size={25} aria-hidden="true" />
                <p>
                  Claude subscription access currently runs through the official Claude Code client.
                  Edi can connect to Anthropic with an API key.
                </p>
                <Button
                  disabled={working || authPending}
                  data-provider-autofocus
                  onClick={() => chooseProtocol('anthropic')}
                >
                  <KeyRound size={13} />
                  Use an Anthropic API key
                </Button>
              </div>
            )}
            {view === 'editor' && (
              <form
                id={formId}
                className="provider-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void save();
                }}
              >
                {existing && (
                  <div className="provider-method-summary">
                    <span>
                      {codex ? <Terminal size={14} /> : <KeyRound size={14} />}
                      {codex ? 'ChatGPT subscription' : 'API key'}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={working || authPending}
                      onClick={() => {
                        remember();
                        setView('method');
                      }}
                    >
                      Change
                      <ChevronDown size={11} />
                    </Button>
                  </div>
                )}
                {codex && (
                  <>
                    <ProviderAccountControls
                      status={authStatus}
                      registrationId={draft.chatgptRegistrationId || ''}
                      loading={authLoading}
                      working={working}
                      onSelect={(id) =>
                        setConnection((current) => ({
                          ...current,
                          profile: { ...current.profile, chatgptRegistrationId: id || null },
                        }))
                      }
                      onSignIn={(id) => void signIn(id)}
                      onCancel={(id) => void cancelSignIn(id)}
                      onSignOut={(id) => void signOut(id)}
                    />
                    {clearKey && (
                      <p className="provider-form-note">
                        Saving this connection removes its saved API key.
                      </p>
                    )}
                    {authError && (
                      <p className="error-text" role="alert">
                        {authError}
                      </p>
                    )}
                    {authNotice && (
                      <p className="provider-account-state" role="status">
                        {authNotice}
                      </p>
                    )}
                    {revocationUnconfirmed && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={working}
                        onClick={() => {
                          void invoke('host_open_external', {
                            url: 'https://chatgpt.com/settings/usage',
                          }).catch((reason) => setAuthError(String(reason)));
                        }}
                      >
                        <ExternalLink size={12} />
                        ChatGPT Settings
                      </Button>
                    )}
                  </>
                )}
                <ProviderConnectionFields
                  connection={connection}
                  working={working}
                  onChange={setConnection}
                />
              </form>
            )}
          </div>
          {error && (
            <p className="provider-error error-text" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-footer provider-footer">
            {view === 'editor' && existing && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={working || authPending || !isDesktop}
                onClick={() => void remove()}
              >
                <Trash2 size={13} />
                Remove connection
              </Button>
            )}
            <span className="provider-footer-spacer" />
            {view === 'connections' ? (
              <Button disabled={working || authPending} onClick={add}>
                <Plus size={13} />
                Add connection
              </Button>
            ) : view === 'editor' ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={working}
                  onClick={() => void close()}
                >
                  Cancel
                </Button>
                {(!codex || (accountReady && !authLoading && !authPending)) && (
                  <Button
                    type="submit"
                    form={formId}
                    disabled={
                      working ||
                      !isDesktop ||
                      authPending ||
                      (codex && (authLoading || !accountReady))
                    }
                  >
                    {working && <LoaderCircle size={13} className="spin" />}
                    {existing ? 'Save changes' : codex ? 'Connect Codex' : 'Connect provider'}
                  </Button>
                )}
              </>
            ) : (
              <Button type="button" variant="ghost" disabled={working} onClick={() => void close()}>
                Cancel
              </Button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
