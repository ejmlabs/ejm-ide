import * as Dialog from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import { Search } from 'lucide-react';
import type { ReactNode } from 'react';

export interface PaletteAction {
  id: string;
  label: string;
  detail?: string;
  shortcut?: string;
  icon: ReactNode;
  run: () => void;
}

export function CommandPalette({
  mode,
  query,
  onQueryChange,
  onClose,
  groups,
}: {
  mode: 'files' | 'commands' | 'context' | null;
  query: string;
  onQueryChange: (query: string) => void;
  onClose: () => void;
  groups: { label: string; items: PaletteAction[] }[];
}) {
  const commands = mode === 'commands' || query.startsWith('>');
  const title =
    mode === 'context' ? 'Add context to chat' : commands ? 'Run a command' : 'Go to file';
  return (
    <Dialog.Root open={!!mode} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay palette-overlay" />
        <Dialog.Content className="dialog-content palette-dialog">
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          <Dialog.Description className="sr-only">
            Search, use the arrow keys to select, and press Enter. Escape closes the menu.
          </Dialog.Description>
          <Command label={title} shouldFilter={false} loop>
            <div className="palette-input">
              <Search size={17} aria-hidden="true" />
              <Command.Input
                value={query}
                onValueChange={onQueryChange}
                placeholder={
                  mode === 'context'
                    ? 'Add a file, symbol, or selection…'
                    : commands
                      ? 'Type a command…'
                      : 'Search files or type > for commands…'
                }
                aria-label="Search palette"
              />
              <kbd>esc</kbd>
            </div>
            <Command.List className="palette-results">
              <Command.Empty className="empty-line">No matches. Try another search.</Command.Empty>
              {groups.map((group) =>
                group.items.length ? (
                  <Command.Group heading={group.label} key={group.label}>
                    {group.items.map((item) => (
                      <Command.Item
                        key={item.id}
                        value={item.id}
                        className="palette-result"
                        onSelect={() => {
                          onClose();
                          item.run();
                        }}
                      >
                        {item.icon}
                        <span>{item.label}</span>
                        {item.detail && <small title={item.detail}>{item.detail}</small>}
                        {item.shortcut && <kbd>{item.shortcut}</kbd>}
                      </Command.Item>
                    ))}
                  </Command.Group>
                ) : null,
              )}
            </Command.List>
            <footer className="palette-footer">
              <span>
                ↑ ↓ to navigate · Enter to {mode === 'context' && !commands ? 'attach' : 'open'}
              </span>
              <span>
                {mode === 'context'
                  ? 'Includes unsaved edits'
                  : commands
                    ? 'Run a command'
                    : '> for commands'}
              </span>
            </footer>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
