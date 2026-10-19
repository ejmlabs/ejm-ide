import type * as monaco from 'monaco-editor/editor/editor.api';
import dark from './ejmlabs-dark.json';
import light from './ejmlabs-light.json';

// Both themes come from the ejmlabs design kit (ui/monaco). Copy new versions in; do not edit them.
export const monacoThemeNames = { dark: 'ejmlabs-dark', light: 'ejmlabs-light' } as const;

export const editorTheme = dark as monaco.editor.IStandaloneThemeData;
export const editorThemeLight = light as monaco.editor.IStandaloneThemeData;
export const editorColors = editorTheme.colors;
export const editorColorsLight = editorThemeLight.colors;
