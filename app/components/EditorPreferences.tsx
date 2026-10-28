import * as Dialog from '@radix-ui/react-dialog';
import { ChevronRight, Keyboard, X } from 'lucide-react';
import { setThemePreference, type ThemePreference, useThemePreference } from '@/lib/theme';
import { PROTECTED_PATHS } from '@/lib/write-approval';
import { Button } from './ui/button';

export function SensitivePathNote() {
  return (
    <details className="settings-shortcuts">
      <summary>Edi asks before changing build and config files.</summary>
      <p className="settings-note">These names are fixed. A project file cannot change them.</p>
      <ul>
        {PROTECTED_PATHS.map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
    </details>
  );
}

export function EditorPreferences({
  open,
  onOpenChange,
  fontSize,
  onFontSizeChange,
  formatOnSave,
  onFormatOnSaveChange,
  lintOnSave,
  onLintOnSaveChange,
  inlineEnabled,
  onInlineEnabledChange,
  onManageConnections,
  connectionsDisabled,
  shortcuts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fontSize: number;
  onFontSizeChange: (size: number) => void;
  formatOnSave: boolean;
  onFormatOnSaveChange: (enabled: boolean) => void;
  lintOnSave: boolean;
  onLintOnSaveChange: (enabled: boolean) => void;
  inlineEnabled: boolean;
  onInlineEnabledChange: (enabled: boolean) => void;
  onManageConnections: () => void;
  connectionsDisabled: boolean;
  shortcuts: { id: string; label: string; hint: string }[];
}) {
  const appearance = useThemePreference();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content settings-dialog">
          <div className="dialog-heading">
            <div>
              <Dialog.Title>Preferences</Dialog.Title>
              <Dialog.Description>Changes save on this device.</Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close settings">
                <X size={17} />
              </Button>
            </Dialog.Close>
          </div>
          <section className="settings-section" aria-labelledby="preferences-appearance">
            <h3 id="preferences-appearance">Appearance</h3>
            <div className="settings-row">
              <span id="preferences-theme-label">
                Theme<small>System follows your device.</small>
              </span>
              <div
                className="theme-choice"
                role="radiogroup"
                aria-labelledby="preferences-theme-label"
              >
                {(['system', 'light', 'dark'] as ThemePreference[]).map((choice) => (
                  <label key={choice}>
                    <input
                      type="radio"
                      name="theme"
                      value={choice}
                      checked={appearance === choice}
                      onChange={() => setThemePreference(choice)}
                    />
                    <span>
                      {choice === 'system' ? 'System' : choice === 'light' ? 'Light' : 'Dark'}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </section>
          <section className="settings-section" aria-labelledby="preferences-editor">
            <h3 id="preferences-editor">Editor</h3>
            <label className="settings-row">
              <span>
                Font size<small>JetBrains Mono</small>
              </span>
              <input
                type="number"
                min={10}
                max={24}
                value={fontSize}
                onChange={(event) =>
                  onFontSizeChange(Math.min(24, Math.max(10, Number(event.target.value) || 13)))
                }
              />
            </label>
          </section>
          <section className="settings-section" aria-labelledby="preferences-save">
            <h3 id="preferences-save">On save</h3>
            <label className="settings-row">
              <span>
                Format code<small>Use the file's formatter.</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                aria-checked={formatOnSave}
                checked={formatOnSave}
                onChange={(event) => onFormatOnSaveChange(event.target.checked)}
              />
            </label>
            <label className="settings-row">
              <span>
                Run linter<small>Show results in Problems.</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                aria-checked={lintOnSave}
                checked={lintOnSave}
                onChange={(event) => onLintOnSaveChange(event.target.checked)}
              />
            </label>
          </section>
          <section className="settings-section" aria-labelledby="preferences-ai">
            <h3 id="preferences-ai">AI assistance</h3>
            <label className="settings-row completion-setting">
              <span>
                Tab completion
                <small>Tab accepts a prediction. Esc dismisses it.</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                aria-checked={inlineEnabled}
                checked={inlineEnabled}
                onChange={(event) => onInlineEnabledChange(event.target.checked)}
              />
            </label>
            <p className="settings-note">
              Predictions send nearby code to your selected provider at the lowest supported effort.
            </p>
            <SensitivePathNote />
            <div className="settings-row settings-connection-row">
              <span>
                Model connections<small>Sign in or use an API key.</small>
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={connectionsDisabled}
                title={
                  connectionsDisabled ? 'Stop the response before changing connections.' : undefined
                }
                onClick={onManageConnections}
              >
                Manage connections
              </Button>
            </div>
          </section>
          <details className="settings-shortcuts">
            <summary>
              <ChevronRight size={13} />
              <Keyboard size={14} /> Keyboard shortcuts
            </summary>
            {shortcuts.map((item) => (
              <div key={item.id}>
                <span>{item.label}</span>
                <kbd>{item.hint}</kbd>
              </div>
            ))}
          </details>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
