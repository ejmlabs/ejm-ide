import { Provider as TooltipProvider } from '@radix-ui/react-tooltip';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { AgentSelection, ProviderProfile } from '@/lib/providers';
import { ModelPicker, ModelProviderSelector } from './ModelPicker';

function renderPicker(selection: Omit<AgentSelection, 'providerId'>) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <ModelPicker
        models={[
          {
            model: 'sol',
            displayName: 'GPT-6.1 Sol',
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Quick responses' }],
          },
        ]}
        selection={{ ...selection, providerId: 'test-provider' }}
        defaults={{ model: 'sol', effort: 'ultra' }}
        disabled={false}
        onChange={vi.fn()}
      />
    </TooltipProvider>,
  );
}

it('names icon selectors with their selected or configured values', () => {
  const configured = renderPicker({ model: '', effort: '' });
  expect(configured).toContain('aria-label="Model: GPT-6.1 Sol"');
  expect(configured).toContain('aria-label="Reasoning: Ultra (Provider default)"');
  const selected = renderPicker({ model: 'sol', effort: 'low' });
  expect(selected).toContain('aria-label="Reasoning: Low"');
  expect(selected).not.toContain('Choose reasoning effort');
  expect(renderPicker({ model: 'sol', effort: '' })).toContain(
    'aria-label="Reasoning: Medium (Provider default)"',
  );
});

it('does not label an unavailable model with another model name or effort', () => {
  const rendered = renderPicker({ model: 'custom-model', effort: '' });
  expect(rendered).toContain('aria-label="Model: custom-model"');
  expect(rendered).toContain('aria-label="Reasoning: Provider default"');
  expect(rendered).toContain(
    'effort-selector" aria-label="Reasoning: Provider default" disabled=""',
  );
});

const profiles: ProviderProfile[] = ['primary', 'secondary'].map((id) => ({
  id,
  name: `${id} connection`,
  protocol: 'openaiCompatible',
  endpoint: 'https://provider.example/v1',
  models: ['sol'],
  reasoning: 'none',
  maxOutputTokens: 4096,
  hasKey: false,
}));

it('uses one named provider control instead of expanding every connection', () => {
  const html = renderToStaticMarkup(
    <ModelProviderSelector
      providers={profiles}
      providerId="secondary"
      disabled={false}
      onChange={vi.fn()}
    />,
  );
  expect(html).toContain('aria-label="Provider: secondary connection"');
  expect(html).toContain('secondary connection</span>');
  expect(html).not.toContain('primary connection');
  expect(html).toContain('aria-haspopup="menu"');
});

it('omits the provider control when there is no choice and keeps busy switching disabled', () => {
  expect(
    renderToStaticMarkup(
      <ModelProviderSelector
        providers={profiles.slice(0, 1)}
        providerId="primary"
        disabled={false}
        onChange={vi.fn()}
      />,
    ),
  ).toBe('');
  expect(
    renderToStaticMarkup(
      <ModelProviderSelector providers={profiles} providerId="primary" disabled={false} />,
    ),
  ).toBe('');
  expect(
    renderToStaticMarkup(
      <ModelProviderSelector
        providers={profiles}
        providerId="primary"
        disabled
        onChange={vi.fn()}
      />,
    ),
  ).toContain('disabled=""');
});
