import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AgentCommand,
  eventMatchesProvider,
  invokeAgent,
  listProviders,
  loadProviderAuthStatus,
  type ProviderProfile,
  type ProviderRegistration,
  parseProviderModels,
  pendingProviderAuth,
  providerModelFallback,
  providerRegistrationLabel,
  providerRegistrationState,
  saveAgentSelection,
  selectionForProvider,
  supportsChatgptSubscription,
  validateProviderProfile,
} from './providers';

const backend = vi.hoisted(() => ({ invoke: vi.fn(), isDesktop: true }));
vi.mock('./backend', () => backend);

function profile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'my-provider',
    name: 'My provider',
    endpoint: 'https://api.example.com/v1',
    protocol: 'openaiCompatible',
    models: ['model-one'],
    reasoning: 'none',
    maxOutputTokens: 4096,
    hasKey: false,
    ...overrides,
  };
}

beforeEach(() => {
  backend.invoke.mockReset();
  backend.isDesktop = true;
});

describe('provider routing', () => {
  it('requires an explicit provider and binds it after caller arguments', async () => {
    backend.invoke.mockResolvedValue({ connected: true });
    await expect(invokeAgent('', 'agent_connect')).rejects.toThrow('Set up a model provider');
    expect(backend.invoke).not.toHaveBeenCalled();
    await expect(
      invokeAgent('selected', 'agent_send', { text: 'Explain this', providerId: 'stale' }),
    ).resolves.toEqual({ connected: true });
    expect(backend.invoke).toHaveBeenCalledWith('agent_send', {
      text: 'Explain this',
      providerId: 'selected',
    });
  });

  it.each<AgentCommand>([
    'agent_new_chat',
    'agent_list_chats',
    'agent_open_chat',
    'agent_chat_turns',
    'agent_rename_chat',
    'agent_archive_chat',
  ])(
    'allows %s to use local workspace history without any configured provider',
    async (command) => {
      backend.invoke.mockResolvedValue({ local: true });
      await expect(
        invokeAgent('', command, { threadId: 'saved-chat', providerId: 'stale' }),
      ).resolves.toEqual({ local: true });
      expect(backend.invoke).toHaveBeenCalledWith(command, {
        threadId: 'saved-chat',
        providerId: '',
      });
    },
  );

  it.each<AgentCommand>([
    'agent_connect',
    'agent_send',
    'agent_cancel',
    'agent_complete',
    'agent_complete_cancel',
    'agent_ide_ack',
    'agent_write_decision',
  ])('still requires a provider for %s', async (command) => {
    await expect(invokeAgent('', command)).rejects.toThrow('Set up a model provider');
    expect(backend.invoke).not.toHaveBeenCalled();
  });

  it('rejects events without the selected provider even for global control events', () => {
    expect(eventMatchesProvider('selected', { providerId: 'selected' })).toBe(true);
    expect(eventMatchesProvider('selected', {})).toBe(false);
    expect(eventMatchesProvider('selected', { providerId: 'other' })).toBe(false);
    expect(eventMatchesProvider('', { providerId: '' })).toBe(false);
  });

  it('does not fabricate providers in browser preview', async () => {
    backend.isDesktop = false;
    await expect(listProviders()).resolves.toEqual([]);
    expect(backend.invoke).not.toHaveBeenCalled();
  });
});

describe('provider preferences', () => {
  it('isolates model preferences by provider and writes no credentials', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) || null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    saveAgentSelection({ providerId: 'one', model: 'first', effort: 'low' }, storage);
    saveAgentSelection({ providerId: 'two', model: 'second', effort: 'high' }, storage);
    expect(selectionForProvider('one', storage)).toEqual({
      providerId: 'one',
      model: 'first',
      effort: 'low',
    });
    expect(selectionForProvider('two', storage)).toEqual({
      providerId: 'two',
      model: 'second',
      effort: 'high',
    });
    expect(values.get('workbench.agent.provider')).toBe('two');
    expect([...values.values()].every((value) => !value.includes('apiKey'))).toBe(true);
  });

  it('recovers from stale or invalid preferences', () => {
    for (const value of ['broken', '[]', '{"model":1,"effort":null}', 'null']) {
      expect(selectionForProvider('one', { getItem: () => value })).toEqual({
        providerId: 'one',
        model: '',
        effort: '',
      });
    }
    expect(
      selectionForProvider('one', {
        getItem: () => {
          throw new Error('unavailable');
        },
      }),
    ).toEqual({ providerId: 'one', model: '', effort: '' });
  });
});

describe('provider profiles', () => {
  it('normalizes model input and does not guess reasoning support', () => {
    expect(parseProviderModels(' alpha, beta\nalpha\n\n beta ')).toEqual(['alpha', 'beta']);
    expect(
      providerModelFallback(profile({ models: ['alpha', 'beta'], reasoning: 'openai' })),
    ).toEqual([
      { model: 'alpha', displayName: 'alpha', isDefault: true, supportedReasoningEfforts: [] },
      { model: 'beta', displayName: 'beta', isDefault: false, supportedReasoningEfforts: [] },
    ]);
  });

  it('accepts HTTPS and local HTTP endpoints with valid output limits', () => {
    expect(validateProviderProfile(profile())).toBeNull();
    for (const endpoint of [
      'http://localhost:11434/v1',
      'http://127.0.0.1:8080',
      'http://[::1]:8080',
    ]) {
      expect(validateProviderProfile(profile({ endpoint }))).toBeNull();
    }
    expect(
      validateProviderProfile(profile({ protocol: 'anthropic', reasoning: 'anthropic' })),
    ).toBeNull();
  });

  it.each([
    { endpoint: 'http://example.com/v1' },
    { endpoint: 'https://key@example.com/v1' },
    { endpoint: 'https://example.com/v1?key=secret' },
    { endpoint: 'https://example.com/v1#secret' },
    { endpoint: 'invalid' },
    { maxOutputTokens: 255 },
    { maxOutputTokens: 65_537 },
    { maxOutputTokens: 1000.5 },
    { apiKeyEnv: 'BAD-NAME' },
    { name: ' ' },
    { models: ['x'.repeat(201)] },
    { reasoning: 'anthropic' as const },
  ])('reports invalid profile input %j', (override) => {
    expect(validateProviderProfile(profile(override))).not.toBeNull();
  });
});

describe('ChatGPT subscription profiles', () => {
  const subscription = () =>
    profile({
      endpoint: 'https://api.openai.com/v1',
      chatgptRegistrationId: 'account-one',
    });

  it.each([
    'https://api.openai.com/v1',
    'https://api.openai.com/v1/',
    ' https://API.OPENAI.COM:443/v1 ',
  ])('allows subscription sign-in only at canonical public OpenAI: %s', (endpoint) =>
    expect(supportsChatgptSubscription(profile({ endpoint }))).toBe(true),
  );

  it.each([
    'https://api.example.com/v1',
    'https://api.openai.com:8443/v1',
    'http://api.openai.com/v1',
    'https://api.openai.com/v1/other',
    'https://api.openai.com/v1?',
    'https://api.openai.com/v1#',
    'https://user@api.openai.com/v1',
    'https://api.openai.com.evil.example/v1',
    'invalid',
  ])('keeps subscription credentials away from other endpoints: %s', (endpoint) => {
    expect(supportsChatgptSubscription(profile({ endpoint }))).toBe(false);
    expect(validateProviderProfile({ ...subscription(), endpoint })).toBeTruthy();
  });

  it('requires a saved account and excludes both new and stored API credentials', () => {
    expect(validateProviderProfile(subscription())).toBeNull();
    expect(validateProviderProfile(subscription(), { hasKey: true, clearKey: true })).toBeNull();
    expect(validateProviderProfile(subscription(), { hasKey: true })).toContain(
      'remove API credentials',
    );
    expect(validateProviderProfile(subscription(), { apiKey: 'new-api-key' })).toContain(
      'remove API credentials',
    );
    expect(validateProviderProfile({ ...subscription(), apiKeyEnv: 'OPENAI_API_KEY' })).toContain(
      'remove API credentials',
    );
    for (const chatgptRegistrationId of ['', 'x'.repeat(65), '../account', 'account@example.com']) {
      expect(validateProviderProfile({ ...subscription(), chatgptRegistrationId })).toContain(
        'saved ChatGPT account',
      );
    }
    expect(validateProviderProfile({ ...subscription(), protocol: 'anthropic' })).toContain(
      'public OpenAI endpoint',
    );
    expect(
      supportsChatgptSubscription({ protocol: 'anthropic', endpoint: 'https://api.openai.com/v1' }),
    ).toBe(false);
  });
});

describe('public provider account state', () => {
  const account: ProviderRegistration = {
    id: 'account-12345678',
    issuer: 'https://auth.openai.com',
    subject: 'validated-subject',
    client_id: 'issued-client',
    email: 'dev@example.com',
    signed_in: true,
    plan_enabled: true,
    expires_at: 1_900_000_000,
  };

  it('loads only public status through the native bridge and stays inert in preview', async () => {
    const status = { registrations: [account] };
    backend.invoke.mockResolvedValue(status);
    await expect(loadProviderAuthStatus()).resolves.toEqual(status);
    expect(backend.invoke).toHaveBeenCalledWith('provider_auth_status');
    backend.invoke.mockClear();
    backend.isDesktop = false;
    await expect(loadProviderAuthStatus()).resolves.toEqual({ registrations: [] });
    expect(backend.invoke).not.toHaveBeenCalled();
  });

  it('uses account metadata for labels and distinguishes missing model access from sign-out', () => {
    expect(providerRegistrationLabel(account)).toBe('dev@example.com');
    expect(providerRegistrationLabel({ ...account, email: null })).toBe('ChatGPT account account-');
    expect(providerRegistrationState(account)).toBe('Signed in');
    expect(providerRegistrationState({ ...account, plan_enabled: false })).toBe(
      'Subscription access unavailable',
    );
    expect(providerRegistrationState({ ...account, signed_in: false })).toBe('Signed out');
    expect(providerRegistrationLabel({ ...account, email: null })).not.toContain(account.subject);
  });

  it('keeps only active browser sign-in phases pending', () => {
    for (const phase of ['starting', 'waiting', 'completing', 'retrying'] as const) {
      expect(pendingProviderAuth({ flowId: 'flow', phase, expiresAt: 1_900_000_000 })).toBe(true);
    }
    for (const phase of ['succeeded', 'cancelled', 'expired', 'failed'] as const) {
      expect(pendingProviderAuth({ flowId: 'flow', phase, expiresAt: 1_900_000_000 })).toBe(false);
    }
    expect(pendingProviderAuth()).toBe(false);
    expect(pendingProviderAuth(null)).toBe(false);
  });
});
