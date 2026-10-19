import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChatRecovery, chatRecovery } from './ChatRecovery';

describe('chat recovery paths', () => {
  it.each([
    'HTTP 401 Unauthorized\n{"error":{"code":"invalid_api_key"}}',
    'HTTP 403 Forbidden',
    'Authentication failed: the token has expired.',
    'No API key configured for this provider.',
    'Subscription access unavailable',
  ])('opens connection settings for authentication failures: %s', (error) => {
    expect(chatRecovery(error).action).toBe('connections');
  });

  it.each([
    'Edi disconnected. Reconnect to continue.',
    'Chat history could not open. Reconnect to retry. Failed to fetch',
    'error sending request for url: connection refused',
    'HTTP 503 Service Unavailable',
  ])('offers reconnection without a model replay: %s', (error) => {
    expect(chatRecovery(error).action).toBe('reconnect');
  });

  it('distinguishes rejected configuration and usage limits from a broken transport', () => {
    expect(chatRecovery('HTTP 400 Bad Request: reasoning_effort is not supported').action).toBe(
      'connections',
    );
    expect(chatRecovery('HTTP 429 Too Many Requests').action).toBe('connections');
    expect(chatRecovery('HTTP 429 Too Many Requests').summary).toContain('usage limit');
  });

  it('does not mislabel file permissions or numeric source locations as provider errors', () => {
    expect(chatRecovery('Permission denied writing src/network.ts:429').action).toBeUndefined();
    expect(chatRecovery('File edit failed at line 401').action).toBeUndefined();
  });

  it('keeps a short local recovery instruction visible without exposing a transport dump', () => {
    expect(chatRecovery('This item could not be attached. Use Add to chat.').summary).toBe(
      'This item could not be attached. Use Add to chat.',
    );
    expect(chatRecovery('Error: Stop the response before switching chats.').summary).toBe(
      'Stop the response before switching chats.',
    );
    expect(chatRecovery('{"unknown":"raw payload"}').summary).toBe('This action could not finish.');
  });

  it('preserves the full error as selectable escaped text behind Details', () => {
    const error =
      'HTTP 400 Bad Request\nrequest-id: request-123\n<script>provider detail</script>\n'.repeat(
        30,
      );
    const markup = renderToStaticMarkup(
      <ChatRecovery
        error={error}
        disabled={false}
        connecting={false}
        onReconnect={vi.fn()}
        onManageConnections={vi.fn()}
      />,
    );
    expect(markup).toContain('<summary>Details</summary>');
    expect(markup).toContain('request-id: request-123');
    expect(markup.match(/request-id: request-123/g)).toHaveLength(30);
    expect(markup).toContain('&lt;script&gt;provider detail&lt;/script&gt;');
    expect(markup).not.toContain('<script>');
    expect(markup).toContain('aria-label="Copy error details"');
    expect(markup).toContain('aria-label="Wrap error details"');
  });

  it('disables recovery while switching or running, while keeping details available', () => {
    const markup = renderToStaticMarkup(
      <ChatRecovery
        error="model discovery failed"
        models
        disabled
        connecting={false}
        onReconnect={vi.fn()}
        onManageConnections={vi.fn()}
      />,
    );
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*[^>]*>Reconnect<\/button>/);
    expect(markup).toContain('<summary>Details</summary>');
    expect(markup).not.toContain('Manage connections');
  });
});
