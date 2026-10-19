import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import { Bot, Check, ChevronDown, Gauge, Search } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { filterAndSortModels } from '@/lib/model-picker';
import type { AgentDefaults, AgentModel, AgentSelection, ProviderProfile } from '@/lib/providers';
import { Tooltip } from './ui/tooltip';
import './model-picker.css';

const effortLabels: Record<string, string> = {
  xhigh: 'Extra high',
  minimal: 'Minimal',
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  max: 'Max',
  ultra: 'Ultra',
};
const effortLabel = (effort: string) => effortLabels[effort] || effort;

export function ModelProviderSelector({
  providers,
  providerId,
  disabled,
  onChange,
}: {
  providers: ProviderProfile[];
  providerId: string;
  disabled: boolean;
  onChange?: (providerId: string) => void;
}) {
  if (providers.length < 2 || !onChange) return null;
  const selected = providers.find((profile) => profile.id === providerId);
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="model-picker-provider-trigger"
          aria-label={`Provider: ${selected?.name || 'Choose provider'}`}
          disabled={disabled}
        >
          <span>{selected?.name || 'Choose provider'}</span>
          <ChevronDown size={12} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="dropdown-content model-picker-provider-menu"
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={12}
        >
          <DropdownMenu.RadioGroup
            value={providerId}
            onValueChange={(id) => {
              if (!disabled) onChange(id);
            }}
          >
            {providers.map((profile) => (
              <DropdownMenu.RadioItem
                className="dropdown-item"
                key={profile.id}
                value={profile.id}
                disabled={disabled}
              >
                <span>{profile.name}</span>
                {profile.id === providerId && <Check size={13} aria-hidden="true" />}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function ModelPicker({
  models,
  selection,
  defaults,
  disabled,
  onChange,
  providers = [],
  onProviderChange,
  onManageProviders,
  defaultLabel = 'Provider default',
}: {
  models: AgentModel[];
  selection: AgentSelection;
  defaults: AgentDefaults;
  disabled: boolean;
  onChange: (selection: AgentSelection) => void;
  providers?: ProviderProfile[];
  onProviderChange?: (providerId: string) => void;
  onManageProviders?: () => void;
  defaultLabel?: string;
}) {
  const [modelOpen, setModelOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeModel, setActiveModel] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const filteredModels = useMemo(() => filterAndSortModels(models, query), [models, query]);
  const showDefault = !query.trim();
  const optionValues = [
    ...(showDefault ? [''] : []),
    ...filteredModels.map((model) => model.model),
  ];
  const activeIndex = Math.max(0, optionValues.indexOf(activeModel ?? selection.model));
  const activeValue = optionValues[activeIndex];
  useEffect(() => {
    if (modelOpen && activeValue !== undefined) {
      listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
    }
  }, [modelOpen, activeValue]);
  function changeOpen(open: boolean) {
    setModelOpen(open && !disabled);
    if (open && !disabled) {
      setQuery('');
      setActiveModel(selection.model);
    }
  }
  useEffect(() => {
    if (disabled) setModelOpen(false);
  }, [disabled]);
  function selectModel(model: string) {
    if (disabled) return;
    onChange({ ...selection, model, effort: '' });
    setModelOpen(false);
  }
  function navigateModels(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!optionValues.length) return;
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setActiveModel(
        optionValues[(activeIndex + direction + optionValues.length) % optionValues.length],
      );
    } else if (event.key === 'Enter' && activeValue !== undefined) {
      event.preventDefault();
      selectModel(activeValue);
    }
  }
  const current =
    models.find((item) => item.model === (selection.model || defaults.model)) ||
    (!selection.model ? models.find((item) => item.isDefault) : undefined);
  const label = selection.model
    ? current?.displayName || selection.model
    : current?.displayName || defaultLabel;
  const defaultEffort = (!selection.model && defaults.effort) || current?.defaultReasoningEffort;
  const modelLabel = `Model: ${label}`;
  const reasoningLabel = `Reasoning: ${
    selection.effort
      ? effortLabel(selection.effort)
      : defaultEffort
        ? `${effortLabel(defaultEffort)} (${defaultLabel})`
        : defaultLabel
  }`;
  return (
    <div className="composer-models">
      <Popover.Root open={modelOpen} onOpenChange={changeOpen} modal={false}>
        <Tooltip label={modelLabel} side="top">
          <Popover.Trigger asChild>
            <button
              type="button"
              className="composer-icon model-selector"
              aria-label={modelLabel}
              disabled={disabled}
            >
              <Bot size={16} aria-hidden="true" />
            </button>
          </Popover.Trigger>
        </Tooltip>
        <Popover.Portal>
          <Popover.Content
            className="dropdown-content model-menu model-picker-popover"
            aria-label="Choose a model"
            side="top"
            align="start"
            sideOffset={6}
            collisionPadding={12}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              searchRef.current?.focus();
            }}
          >
            <ModelProviderSelector
              providers={providers}
              providerId={selection.providerId}
              disabled={disabled}
              onChange={
                onProviderChange
                  ? (id) => {
                      onProviderChange(id);
                      setModelOpen(false);
                    }
                  : undefined
              }
            />
            <div className="model-picker-search">
              <Search size={13} aria-hidden="true" />
              <input
                ref={searchRef}
                role="combobox"
                aria-label="Search models"
                aria-autocomplete="list"
                aria-expanded={modelOpen}
                aria-controls={listId}
                aria-activedescendant={
                  activeValue === undefined ? undefined : `${listId}-${activeIndex}`
                }
                placeholder="Search models…"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveModel(null);
                }}
                onKeyDown={navigateModels}
              />
            </div>
            <div className="model-picker-results" ref={listRef}>
              <div id={listId} role="listbox" aria-label="Models">
                {showDefault && (
                  <button
                    type="button"
                    role="option"
                    id={`${listId}-0`}
                    aria-selected={!selection.model}
                    data-active={activeValue === ''}
                    tabIndex={-1}
                    className="dropdown-item model-item model-picker-option"
                    onPointerMove={() => setActiveModel('')}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => selectModel('')}
                  >
                    <span>
                      <strong>{defaultLabel}</strong>
                      <small>{defaults.model || 'Configured default'}</small>
                    </span>
                    {!selection.model && <Check size={13} aria-hidden="true" />}
                  </button>
                )}
                {filteredModels.map((model, index) => (
                  <button
                    type="button"
                    role="option"
                    id={`${listId}-${index + (showDefault ? 1 : 0)}`}
                    className="dropdown-item model-item model-picker-option"
                    key={model.model}
                    title={model.description ? `${model.model}\n${model.description}` : model.model}
                    aria-selected={selection.model === model.model}
                    data-active={activeValue === model.model}
                    tabIndex={-1}
                    onPointerMove={() => setActiveModel(model.model)}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => selectModel(model.model)}
                  >
                    <span>
                      <strong>{model.displayName || model.model}</strong>
                      {model.displayName && model.displayName !== model.model ? (
                        <small>{model.model}</small>
                      ) : (
                        model.description && <small>{model.description}</small>
                      )}
                    </span>
                    {selection.model === model.model && <Check size={13} aria-hidden="true" />}
                  </button>
                ))}
              </div>
              {!optionValues.length && (
                <p className="model-picker-empty" role="status">
                  No models match “{query.trim()}”.
                </p>
              )}
            </div>
            {onManageProviders && (
              <div className="model-picker-footer">
                <div className="dropdown-separator" />
                <button
                  type="button"
                  className="dropdown-item"
                  onClick={() => {
                    setModelOpen(false);
                    onManageProviders();
                  }}
                >
                  Manage connections…
                </button>
              </div>
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <DropdownMenu.Root>
        <Tooltip label={reasoningLabel} side="top">
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="composer-icon effort-selector"
              aria-label={reasoningLabel}
              disabled={disabled || !current?.supportedReasoningEfforts?.length}
            >
              <Gauge size={16} aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
        </Tooltip>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="dropdown-content effort-menu"
            side="top"
            align="start"
            sideOffset={6}
          >
            <DropdownMenu.Label className="dropdown-label">Reasoning effort</DropdownMenu.Label>
            <DropdownMenu.RadioGroup
              value={selection.effort}
              onValueChange={(effort) => {
                if (!disabled) onChange({ ...selection, effort });
              }}
            >
              <DropdownMenu.RadioItem className="dropdown-item" value="" disabled={disabled}>
                <span>
                  Default
                  {defaultEffort ? ` (${effortLabel(defaultEffort)})` : ''}
                </span>
                {!selection.effort && <Check size={13} />}
              </DropdownMenu.RadioItem>
              {current?.supportedReasoningEfforts?.map((option) => (
                <DropdownMenu.RadioItem
                  className="dropdown-item effort-item"
                  key={option.reasoningEffort}
                  value={option.reasoningEffort}
                  disabled={disabled}
                >
                  <span>
                    <strong>{effortLabel(option.reasoningEffort)}</strong>
                    <small>{option.description}</small>
                  </span>
                  {selection.effort === option.reasoningEffort && <Check size={13} />}
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
