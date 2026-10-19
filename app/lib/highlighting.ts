import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { editorTheme, editorThemeLight, monacoThemeNames } from './editor-theme';

function syntaxTheme(name: string, type: 'dark' | 'light', source: typeof editorTheme) {
  return {
    name,
    type,
    colors: source.colors,
    tokenColors: [
      {
        settings: {
          foreground: source.colors['editor.foreground'],
          background: source.colors['editor.background'],
        },
      },
      ...source.rules.map(({ token, foreground, background, fontStyle }) => ({
        scope: token,
        settings: {
          foreground: foreground ? `#${foreground}` : undefined,
          background: background ? `#${background}` : undefined,
          fontStyle,
        },
      })),
    ],
  };
}

let highlighter: ReturnType<typeof createHighlighterCore> | undefined;

export function createSyntaxHighlighter() {
  highlighter ??= createHighlighterCore({
    engine: createJavaScriptRegexEngine({ target: 'ES2018' }),
    themes: [
      syntaxTheme(monacoThemeNames.dark, 'dark', editorTheme),
      syntaxTheme(monacoThemeNames.light, 'light', editorThemeLight),
    ],
    langs: [
      import('shiki/langs/rust.mjs'),
      import('shiki/langs/python.mjs'),
      import('shiki/langs/ruby.mjs'),
      import('shiki/langs/go.mjs'),
      import('shiki/langs/typescript.mjs'),
      import('shiki/langs/javascript.mjs'),
      import('shiki/langs/tsx.mjs'),
      import('shiki/langs/jsx.mjs'),
      import('shiki/langs/markdown.mjs'),
      import('shiki/langs/json.mjs'),
      import('shiki/langs/jsonc.mjs'),
      import('shiki/langs/toml.mjs'),
      import('shiki/langs/ini.mjs'),
      import('shiki/langs/yaml.mjs'),
      import('shiki/langs/html.mjs'),
      import('shiki/langs/css.mjs'),
      import('shiki/langs/scss.mjs'),
      import('shiki/langs/less.mjs'),
      import('shiki/langs/sql.mjs'),
      import('shiki/langs/shellscript.mjs'),
      import('shiki/langs/xml.mjs'),
      import('shiki/langs/dockerfile.mjs'),
      import('shiki/langs/graphql.mjs'),
    ],
  });
  return highlighter;
}
