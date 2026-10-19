import type { AgentModel } from './providers';

const modelOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export function filterAndSortModels(models: readonly AgentModel[], query: string): AgentModel[] {
  const terms = query.trim().toLocaleLowerCase('en').split(/\s+/).filter(Boolean);
  return models
    .filter((model) => {
      const searchable = `${model.displayName} ${model.model}`.toLocaleLowerCase('en');
      return terms.every((term) => searchable.includes(term));
    })
    .sort(
      (left, right) =>
        modelOrder.compare(left.displayName || left.model, right.displayName || right.model) ||
        modelOrder.compare(left.model, right.model) ||
        left.model.localeCompare(right.model, 'en'),
    );
}
