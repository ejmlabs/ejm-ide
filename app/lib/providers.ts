import { invoke, isDesktop } from './backend';

export type ProviderProtocol = 'openaiCompatible' | 'anthropic';
export type ProviderReasoning = 'none' | 'openai' | 'anthropic';
export const MIN_OUTPUT_TOKENS = 256;
export const MAX_OUTPUT_TOKENS = 65_536;
export interface ProviderProfile {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  endpoint: string;
  models: string[];
  reasoning: ProviderReasoning;
  maxOutputTokens: number;
  hasKey: boolean;
  apiKeyEnv?: string | null;
  chatgptRegistrationId?: string | null;
}
export interface ProviderRegistration {
  id: string;
  issuer: string;
  subject: string;
  client_id: string;
  email?: string | null;
  signed_in: boolean;
  plan_enabled: boolean;
  expires_at?: number | null;
}
export interface ProviderAuthFlow {
  flowId: string;
  phase:
    | 'starting'
    | 'waiting'
    | 'completing'
    | 'retrying'
    | 'succeeded'
    | 'cancelled'
    | 'expired'
    | 'failed';
  expiresAt: number;
  error?: string;
}
export interface ProviderAuthStatus {
  registrations: ProviderRegistration[];
  flow?: ProviderAuthFlow | null;
}

export function supportsChatgptSubscription(
  profile: Pick<ProviderProfile, 'protocol' | 'endpoint'>,
): boolean {
  if (profile.protocol !== 'openaiCompatible') return false;
  try {
    return new URL(profile.endpoint.trim()).href.replace(/\/$/, '') === 'https://api.openai.com/v1';
  } catch {
    return false;
  }
}

export function pendingProviderAuth(flow?: ProviderAuthFlow | null): boolean {
  return !!flow && ['starting', 'waiting', 'completing', 'retrying'].includes(flow.phase);
}

export function providerRegistrationLabel(account: ProviderRegistration): string {
  return account.email || `ChatGPT account ${account.id.slice(0, 8)}`;
}

export function providerRegistrationState(account: ProviderRegistration): string {
  if (!account.signed_in) return 'Signed out';
  return account.plan_enabled ? 'Signed in' : 'Subscription access unavailable';
}

export async function loadProviderAuthStatus(): Promise<ProviderAuthStatus> {
  if (!isDesktop) return { registrations: [] };
  return invoke<ProviderAuthStatus>('provider_auth_status');
}

export interface AgentSelection {
  providerId: string;
  model: string;
  effort: string;
}
export interface AgentModel {
  model: string;
  displayName: string;
  description?: string;
  isDefault?: boolean;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  defaultReasoningEffort?: string;
}
export interface AgentDefaults {
  model?: string | null;
  effort?: string | null;
}
export type AgentCommand =
  | 'agent_connect'
  | 'agent_send'
  | 'agent_cancel'
  | 'agent_new_chat'
  | 'agent_list_chats'
  | 'agent_open_chat'
  | 'agent_chat_turns'
  | 'agent_rename_chat'
  | 'agent_archive_chat'
  | 'agent_complete'
  | 'agent_complete_cancel'
  | 'agent_ide_ack'
  | 'agent_write_decision';

const LOCAL_CHAT_COMMANDS: readonly AgentCommand[] = [
  'agent_new_chat',
  'agent_list_chats',
  'agent_open_chat',
  'agent_chat_turns',
  'agent_rename_chat',
  'agent_archive_chat',
];

export function invokeAgent<T>(
  providerId: string,
  command: AgentCommand,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (!providerId && !LOCAL_CHAT_COMMANDS.includes(command))
    return Promise.reject(new Error('Set up a model provider to continue.'));
  return invoke<T>(command, { ...args, providerId });
}
export function eventMatchesProvider(providerId: string, event: { providerId?: string }): boolean {
  return !!providerId && event.providerId === providerId;
}
export function selectionForProvider(
  providerId: string,
  storage: Pick<Storage, 'getItem'> = localStorage,
): AgentSelection {
  try {
    const stored: unknown = JSON.parse(storage.getItem(selectionKey(providerId)) || 'null');
    if (stored && typeof stored === 'object' && 'model' in stored && 'effort' in stored)
      return {
        providerId,
        model: typeof stored.model === 'string' ? stored.model : '',
        effort: typeof stored.effort === 'string' ? stored.effort : '',
      };
  } catch {
    // A stale preference does not prevent the provider from opening.
  }
  return { providerId, model: '', effort: '' };
}
function selectionKey(providerId: string): string {
  return `workbench.agent.selection.${encodeURIComponent(providerId)}`;
}
export function saveAgentSelection(
  selection: AgentSelection,
  storage: Pick<Storage, 'setItem'> = localStorage,
) {
  storage.setItem('workbench.agent.provider', selection.providerId);
  storage.setItem(
    selectionKey(selection.providerId),
    JSON.stringify({ model: selection.model, effort: selection.effort }),
  );
}
export async function listProviders(): Promise<ProviderProfile[]> {
  if (!isDesktop) return [];
  return invoke<ProviderProfile[]>('provider_list');
}
export function providerModelFallback(profile: ProviderProfile): AgentModel[] {
  return profile.models.map((model, index) => ({
    model,
    displayName: model,
    isDefault: index === 0,
    supportedReasoningEfforts: [],
  }));
}
export function parseProviderModels(input: string): string[] {
  return [
    ...new Set(
      input
        .split(/[\n,]/)
        .map((model) => model.trim())
        .filter(Boolean),
    ),
  ];
}
export function validateProviderProfile(
  profile: Omit<ProviderProfile, 'hasKey'>,
  credentials: { apiKey?: string; hasKey?: boolean; clearKey?: boolean } = {},
): string | null {
  if (!profile.name.trim()) return 'Enter a name for this provider.';
  const bytes = (value: string) => new TextEncoder().encode(value).length;
  if (bytes(profile.name) > 80 || /\p{Cc}/u.test(profile.name))
    return 'Use a provider name of at most 80 bytes without control characters.';
  try {
    const url = new URL(profile.endpoint);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.href.length > 2048
    )
      return 'Use HTTPS, or HTTP on localhost, without credentials, query, or fragment.';
  } catch {
    return 'Enter a complete endpoint URL.';
  }
  if (
    !Number.isSafeInteger(profile.maxOutputTokens) ||
    profile.maxOutputTokens < MIN_OUTPUT_TOKENS ||
    profile.maxOutputTokens > MAX_OUTPUT_TOKENS
  )
    return 'Max output must be between 256 and 65,536 tokens.';
  if (
    profile.models.length > 128 ||
    profile.models.some((model) => !model || bytes(model) > 200 || /\p{Cc}/u.test(model))
  )
    return 'Use at most 128 model IDs, each at most 200 bytes without control characters.';
  if (
    profile.apiKeyEnv &&
    (profile.apiKeyEnv.length > 128 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(profile.apiKeyEnv))
  )
    return 'Enter an environment variable name, such as OPENAI_API_KEY.';
  if (profile.chatgptRegistrationId != null) {
    if (!supportsChatgptSubscription(profile))
      return 'ChatGPT subscription sign-in requires the public OpenAI endpoint.';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(profile.chatgptRegistrationId))
      return 'Choose a saved ChatGPT account.';
    if (
      profile.apiKeyEnv ||
      credentials.apiKey?.trim() ||
      (credentials.hasKey && !credentials.clearKey)
    )
      return 'Switch to ChatGPT and remove API credentials before saving.';
  }
  if (
    (profile.protocol === 'anthropic' && profile.reasoning === 'openai') ||
    (profile.protocol === 'openaiCompatible' && profile.reasoning === 'anthropic')
  )
    return 'The reasoning format must match the API format.';
  return null;
}
