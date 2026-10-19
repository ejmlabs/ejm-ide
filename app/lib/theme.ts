import { useSyncExternalStore } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ThemeMode = 'light' | 'dark';

const storageKey = 'workbench.theme';
const listeners = new Set<() => void>();
const query = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;

function readPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(storageKey);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

let preference = readPreference();

export function themePreference(): ThemePreference {
  return preference;
}

export function resolvedTheme(): ThemeMode {
  if (preference !== 'system') return preference;
  return query?.matches ? 'light' : 'dark';
}

function apply(): void {
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = resolvedTheme();
  for (const listener of listeners) listener();
}

export function setThemePreference(next: ThemePreference): void {
  preference = next;
  try {
    if (next === 'system') localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, next);
  } catch {
    // The choice still applies for this session.
  }
  apply();
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Resolved mode, updated when the preference or the system setting changes. */
export function useTheme(): ThemeMode {
  return useSyncExternalStore(subscribeTheme, resolvedTheme, () => 'dark');
}

/** The stored choice, including System. */
export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribeTheme, themePreference, () => 'system');
}

query?.addEventListener('change', () => {
  if (preference === 'system') apply();
});
apply();
