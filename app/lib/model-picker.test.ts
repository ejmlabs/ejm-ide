import { expect, it } from 'vitest';
import { filterAndSortModels } from './model-picker';
import type { AgentModel } from './providers';

const model = (id: string, displayName = id): AgentModel => ({
  model: id,
  displayName,
  supportedReasoningEfforts: [],
});

it('sorts naturally by display name and then full ID without changing provider order', () => {
  const models = [
    model('z/model-10', 'Model 10'),
    model('z/model-2', 'model 2'),
    model('a/model-2', 'Model 2'),
    model('ALPHA', ''),
  ];
  expect(filterAndSortModels(models, '').map((item) => item.model)).toEqual([
    'ALPHA',
    'a/model-2',
    'z/model-2',
    'z/model-10',
  ]);
  expect(models[0].model).toBe('z/model-10');
});

it('searches display names and full provider model IDs with case-insensitive terms', () => {
  const models = [
    model('anthropic/claude-sonnet-4-5', 'Claude Sonnet'),
    model('openai/gpt-6.1-sol', 'GPT Sol'),
  ];
  expect(filterAndSortModels(models, '  SONNET  ANTHROPIC/  ')).toEqual([models[0]]);
  expect(filterAndSortModels(models, 'GPT-6.1')).toEqual([models[1]]);
  expect(filterAndSortModels(models, 'sonnet openai')).toEqual([]);
  expect(filterAndSortModels(models, '   ')).toHaveLength(2);
});

it('preserves model metadata and default flags while sorting', () => {
  const selected = { ...model('z', 'Zeta'), isDefault: true, defaultReasoningEffort: 'high' };
  expect(filterAndSortModels([selected, model('a', 'Alpha')], 'zeta')[0]).toBe(selected);
});
