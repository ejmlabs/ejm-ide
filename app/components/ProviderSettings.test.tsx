import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderRegistration } from '@/lib/providers';
import {
  type ConnectionDraft,
  changeConnectionMethod,
  ProviderAccountControls,
  ProviderApiFormatChoices,
  ProviderConnectionChoices,
  ProviderConnectionFields,
  ProviderPendingSignIn,
} from './ProviderSettings';

const backend = vi.hoisted(() => ({ invoke: vi.fn(), isDesktop: false, onEvent: vi.fn() }));
vi.mock('@/lib/backend', () => backend);

const account: ProviderRegistration = {
  id: 'account-one',
  issuer: 'https://auth.openai.com',
  subject: 'validated-subject',
  client_id: 'issued-client',
  email: 'dev@example.com',
  signed_in: true,
  plan_enabled: true,
  expires_at: 1_900_000_000,
};

function controls(overrides: Partial<ComponentProps<typeof ProviderAccountControls>> = {}) {
  return renderToStaticMarkup(
    <ProviderAccountControls
      status={{ registrations: [account] }}
      registrationId={account.id}
      loading={false}
      working={false}
      available
      onSelect={vi.fn()}
      onSignIn={vi.fn()}
      onCancel={vi.fn()}
      onSignOut={vi.fn()}
      {...overrides}
    />,
  );
}

describe('subscription account controls', () => {
  it('shows public account state and explicit account actions', () => {
    const markup = controls();
    expect(markup).toContain('dev@example.com');
    expect(markup).toContain('Signed in');
    expect(markup).toContain('Sign out');
    expect(markup).toContain('Add account');
    expect(markup).toContain('Sign in again');
    expect(markup).not.toContain(account.subject);
    expect(markup).not.toContain(account.client_id);
    expect(markup).not.toContain(account.issuer);
  });

  it('distinguishes missing subscription access from a signed-out identity', () => {
    const noAccess = controls({ status: { registrations: [{ ...account, plan_enabled: false }] } });
    expect(noAccess).toContain('Subscription access unavailable');
    expect(noAccess).toContain('Sign in again to grant model access.');
    const signedOut = controls({ status: { registrations: [{ ...account, signed_in: false }] } });
    expect(signedOut).toContain('Signed out');
    expect(signedOut).toContain('Sign in with ChatGPT');
    expect(signedOut).not.toContain('>Sign out<');
  });

  it.each(['starting', 'waiting', 'completing', 'retrying'] as const)(
    'offers cancellation while %s without exposing authorization data',
    (phase) => {
      const markup = controls({
        status: {
          registrations: [account],
          flow: { flowId: 'one-use-flow', phase, expiresAt: 1_900_000_000 },
        },
      });
      expect(markup).toContain('Cancel sign-in');
      expect(markup).toContain('Expires at');
      expect(markup).not.toContain('one-use-flow');
      expect(markup).not.toContain('authorization_url');
      expect(markup).not.toContain('>Sign in again<');
      expect(markup).not.toContain('>Sign out<');
    },
  );

  it('renders fixed native errors as text and permits a new attempt after failure', () => {
    const markup = controls({
      status: {
        registrations: [],
        flow: {
          flowId: 'failed-flow',
          phase: 'failed',
          expiresAt: 1_900_000_000,
          error: '<script>Native sign-in failed</script>',
        },
      },
      registrationId: '',
    });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('&lt;script&gt;Native sign-in failed&lt;/script&gt;');
    expect(markup).not.toContain('<script>');
    expect(markup).toContain('Sign in with ChatGPT');
    expect(markup).not.toContain('Cancel sign-in');
  });

  it('preserves an unavailable selected account rather than silently selecting another', () => {
    const markup = controls({ registrationId: 'missing-account' });
    expect(markup).toContain(
      '<option value="missing-account" selected="">Saved account unavailable</option>',
    );
    expect(markup).toContain('This account is unavailable. Sign in or choose another account.');
    expect(markup).not.toContain('>Sign out<');
  });

  it('keeps browser preview account actions disabled and makes no native calls', () => {
    const markup = controls({
      status: { registrations: [] },
      registrationId: '',
      available: false,
    });
    expect(markup).not.toContain('<select');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*Sign in with ChatGPT<\/button>/);
    expect(backend.invoke).not.toHaveBeenCalled();
    expect(backend.onEvent).not.toHaveBeenCalled();
  });
});

const connection: ConnectionDraft = {
  profile: {
    id: 'provider-one',
    name: 'My provider',
    protocol: 'openaiCompatible',
    endpoint: 'https://gateway.example.com/v1',
    models: ['example-model'],
    reasoning: 'openai',
    maxOutputTokens: 4096,
    apiKeyEnv: 'MY_PROVIDER_KEY',
    hasKey: true,
  },
  modelText: 'example-model\nunsaved-model',
  apiKey: 'draft-key-fixture',
  clearKey: false,
  credentialMode: 'apiKey',
};

describe('progressive provider setup', () => {
  it('starts with recognizable connection methods and states the Anthropic limit', () => {
    const markup = renderToStaticMarkup(<ProviderConnectionChoices onChoose={vi.fn()} />);
    expect(markup).toContain('>Codex<');
    expect(markup).toContain('>Anthropic<');
    expect(markup).toContain('>API key<');
    expect(markup).toContain('Unavailable');
    expect(markup).toContain('ChatGPT subscription');
    expect(markup).not.toContain('<input');
    expect(markup).not.toContain('Reasoning format');
  });

  it('asks for API compatibility before showing credentials or endpoint details', () => {
    const markup = renderToStaticMarkup(<ProviderApiFormatChoices onChoose={vi.fn()} />);
    expect(markup).toContain('>OpenAI-compatible<');
    expect(markup).toContain('>Anthropic-compatible<');
    expect(markup).not.toContain('<input');
    expect(markup).not.toContain('subscription');
  });

  it('keeps API key and URL in the main form, with rare settings in a closed disclosure', () => {
    const markup = renderToStaticMarkup(
      <ProviderConnectionFields
        connection={{
          ...connection,
          profile: { ...connection.profile, apiKeyEnv: null },
          apiKey: '',
        }}
        working={false}
        onChange={vi.fn()}
      />,
    );
    const advanced = markup.indexOf('<details class="provider-advanced">');
    expect(advanced).toBeGreaterThan(markup.indexOf('API key'));
    expect(advanced).toBeGreaterThan(markup.indexOf('API URL'));
    expect(advanced).toBeLessThan(markup.indexOf('Connection name'));
    expect(advanced).toBeLessThan(markup.indexOf('Model IDs'));
    expect(advanced).toBeLessThan(markup.indexOf('Reasoning format'));
    expect(markup).not.toContain('<details class="provider-advanced" open');
    expect(markup).toContain('Saved in your keychain');
    expect(markup).toContain('Leave blank to keep the saved key.');
  });

  it('makes an existing environment credential visible without offering an ignored key input', () => {
    const markup = renderToStaticMarkup(
      <ProviderConnectionFields connection={connection} working={false} onChange={vi.fn()} />,
    );
    expect(markup).toContain('Key from');
    expect(markup).toContain('MY_PROVIDER_KEY');
    expect(markup).toContain('Use a saved key');
    expect(markup).not.toContain('type="password"');
    expect(markup).not.toContain('draft-key-fixture');
  });

  it('never renders API credentials or a configurable endpoint for Codex subscription', () => {
    const markup = renderToStaticMarkup(
      <ProviderConnectionFields
        connection={changeConnectionMethod(connection, 'codex')}
        working={false}
        onChange={vi.fn()}
      />,
    );
    expect(markup).not.toContain('type="password"');
    expect(markup).not.toContain('API URL');
    expect(markup).not.toContain('Key environment variable');
    expect(markup).not.toContain('MY_PROVIDER_KEY');
    expect(markup).not.toContain('draft-key-fixture');
    expect(markup).toContain('Advanced');
  });

  it('shows account management behind a disclosure after the account is ready', () => {
    const markup = controls();
    expect(markup).toContain('<details class="provider-account-options">');
    expect(markup).toContain('Account options');
    expect(markup).not.toContain('provider-sign-in');
    expect(markup).not.toContain('open=""');
  });
});

describe('connection method transitions', () => {
  it('switches to Codex at the canonical endpoint and stages API credential removal', () => {
    const next = changeConnectionMethod(connection, 'codex');
    expect(next.profile.id).toBe(connection.profile.id);
    expect(next.profile.endpoint).toBe('https://api.openai.com/v1');
    expect(next.profile.apiKeyEnv).toBeNull();
    expect(next.apiKey).toBe('');
    expect(next.clearKey).toBe(true);
    expect(next.credentialMode).toBe('chatgpt');
    expect(next.profile.reasoning).toBe('openai');
    expect(next.modelText).toBe(connection.modelText);
    expect(connection.apiKey).toBe('draft-key-fixture');
  });

  it('removes subscription binding when switching back to API credentials', () => {
    const subscribed = changeConnectionMethod(connection, 'codex');
    subscribed.profile.chatgptRegistrationId = account.id;
    const next = changeConnectionMethod(subscribed, 'apiKey');
    expect(next.profile.chatgptRegistrationId).toBeNull();
    expect(next.profile.apiKeyEnv).toBeNull();
    expect(next.apiKey).toBe('');
    expect(next.credentialMode).toBe('apiKey');
    expect(next.clearKey).toBe(true);
  });

  it('clears incompatible credentials and reasoning when changing API families', () => {
    const next = changeConnectionMethod(connection, 'apiKey', 'anthropic');
    expect(next.profile.endpoint).toBe('https://api.anthropic.com/v1');
    expect(next.profile.protocol).toBe('anthropic');
    expect(next.profile.reasoning).toBe('none');
    expect(next.profile.apiKeyEnv).toBeNull();
    expect(next.apiKey).toBe('');
    expect(next.clearKey).toBe(true);
  });

  it('restores a custom API draft after Codex while preserving staged key removal', () => {
    const subscribed = changeConnectionMethod(connection, 'codex');
    const restored = changeConnectionMethod(subscribed, 'apiKey', 'openaiCompatible', connection);
    expect(restored.profile.endpoint).toBe('https://gateway.example.com/v1');
    expect(restored.profile.apiKeyEnv).toBe('MY_PROVIDER_KEY');
    expect(restored.profile.reasoning).toBe('openai');
    expect(restored.modelText).toBe(connection.modelText);
    expect(restored.apiKey).toBe('');
    expect(restored.clearKey).toBe(true);
    expect(restored.profile.chatgptRegistrationId).toBeNull();
  });

  it('does not restore a different connection or incompatible method draft', () => {
    const subscribed = changeConnectionMethod(connection, 'codex');
    const unrelated = {
      ...connection,
      profile: { ...connection.profile, id: 'different-profile' },
    };
    const restored = changeConnectionMethod(subscribed, 'apiKey', 'openaiCompatible', unrelated);
    expect(restored.profile.endpoint).toBe('https://api.openai.com/v1');
    expect(restored.apiKey).toBe('');
    expect(restored.clearKey).toBe(true);
    const incompatible = changeConnectionMethod(subscribed, 'apiKey', 'anthropic', connection);
    expect(incompatible.profile.endpoint).toBe('https://api.anthropic.com/v1');
    expect(incompatible.profile.apiKeyEnv).toBeNull();
  });

  it('preserves a compatible custom endpoint and edited key removal choice', () => {
    const draft = { ...connection, clearKey: true };
    const next = changeConnectionMethod(draft, 'apiKey');
    expect(next.profile.endpoint).toBe(connection.profile.endpoint);
    expect(next.modelText).toBe(connection.modelText);
    expect(next.apiKey).toBe(connection.apiKey);
    expect(next.clearKey).toBe(true);
  });
});

describe('restored sign-in recovery', () => {
  it('shows a visible cancellation action outside the account form', () => {
    const markup = renderToStaticMarkup(
      <ProviderPendingSignIn
        flow={{ flowId: 'pending-native-flow', phase: 'waiting', expiresAt: 1_900_000_000 }}
        working={false}
        available
        onCancel={vi.fn()}
      />,
    );
    expect(markup).toContain('ChatGPT sign-in in progress');
    expect(markup).toContain('Finish signing in in your browser.');
    expect(markup).toContain('Cancel sign-in');
    expect(markup).not.toContain('pending-native-flow');
    expect(markup).not.toContain('disabled=""');
  });

  it('does not show a stale cancellation action after the flow completes', () => {
    const markup = renderToStaticMarkup(
      <ProviderPendingSignIn
        flow={{ flowId: 'completed-native-flow', phase: 'succeeded', expiresAt: 1_900_000_000 }}
        working={false}
        available
        onCancel={vi.fn()}
      />,
    );
    expect(markup).toBe('');
  });
});
