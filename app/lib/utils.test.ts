import { expect, it } from 'vitest';
import { basename, hasBuiltInLanguageService, isJsonComments, languageId } from './utils';

it.each(['orders.rb', 'Gemfile', 'Rakefile', 'orders.gemspec', 'config.ru'])(
  'recognizes Ruby source in %s',
  (file) => expect(languageId(`/workspace/${file}`)).toBe('ruby'),
);

it('recognizes Go and JavaScript module variants', () => {
  expect(languageId('/workspace/orders.go')).toBe('go');
  expect(languageId('/workspace/orders.mts')).toBe('typescript');
  expect(languageId('/workspace/orders.cjs')).toBe('javascript');
});

it.each(['README.md', 'notes.markdown', 'NOTES.MD', 'guide.MARKDOWN'])(
  'recognizes Markdown source in %s',
  (file) => expect(languageId(`/workspace/${file}`)).toBe('markdown'),
);

it.each([
  ['data.json', 'json'],
  ['data.JSONC', 'json'],
  ['workspace.code-workspace', 'json'],
  ['team.code-snippets', 'json'],
  ['config.YAML', 'yaml'],
  ['Cargo.lock', 'toml'],
  ['Pipfile', 'toml'],
  ['poetry.lock', 'toml'],
  ['uv.lock', 'toml'],
  ['settings.toml', 'toml'],
  ['settings.ini', 'ini'],
  ['settings.cfg', 'ini'],
  ['server.conf', 'ini'],
  ['messages.properties', 'ini'],
  ['.editorconfig', 'ini'],
  ['.env', 'ini'],
  ['.env.local', 'ini'],
  ['index.HTML', 'html'],
  ['style.css', 'css'],
  ['style.scss', 'scss'],
  ['style.less', 'less'],
  ['query.sql', 'sql'],
  ['query.graphql', 'graphql'],
  ['query.gql', 'graphql'],
  ['image.svg', 'xml'],
  ['config.xml', 'xml'],
  ['Info.plist', 'xml'],
  ['Dockerfile', 'dockerfile'],
  ['Dockerfile.prod', 'dockerfile'],
  ['Containerfile.dev', 'dockerfile'],
  ['build.dockerfile', 'dockerfile'],
  ['script.sh', 'shell'],
  ['script.zsh', 'shell'],
  ['.bashrc', 'shell'],
  ['.zprofile', 'shell'],
])('recognizes common file %s as %s', (file, language) => {
  expect(languageId(`/workspace/${file}`)).toBe(language);
});

it.each(['json', 'py', 'ts', 'README', '.gitignore', 'data.unknown'])(
  'keeps extensionless or unknown file %s as plain text',
  (file) => expect(languageId(`/workspace/${file}`)).toBe('plaintext'),
);

it('recognizes special filenames with Windows path separators', () => {
  expect(basename('C:\\workspace\\Gemfile')).toBe('Gemfile');
  expect(languageId('C:\\workspace\\Dockerfile.dev')).toBe('dockerfile');
  expect(languageId('C:\\workspace\\.env.local')).toBe('ini');
});

it.each([
  '/workspace/notes.jsonc',
  '/workspace/app.code-workspace',
  '/workspace/ruby.code-snippets',
  '/workspace/tsconfig.json',
  '/workspace/tsconfig.test.json',
  '/workspace/jsconfig.dev.json',
  '/workspace/.vscode/settings.json',
  '/workspace/.vscode/launch.json',
  '/workspace/.vscode/tasks.json',
  '/workspace/.vscode/extensions.json',
  'C:\\workspace\\.vscode\\settings.JSON',
])('allows JSON comments in %s', (path) => {
  expect(isJsonComments(path)).toBe(true);
  expect(languageId(path)).toBe('json');
});

it.each([
  '/workspace/package.json',
  '/workspace/settings.json',
  '/workspace/launch.json',
  '/workspace/.vscode/package.json',
  '/workspace/jsonc',
])('keeps ordinary JSON strict in %s', (path) => {
  expect(isJsonComments(path)).toBe(false);
});

it('identifies the built-in language services without claiming other syntax modes', () => {
  for (const language of ['json', 'html', 'css', 'scss', 'less'])
    expect(hasBuiltInLanguageService(language)).toBe(true);
  for (const language of [
    'yaml',
    'toml',
    'ini',
    'sql',
    'shell',
    'xml',
    'dockerfile',
    'graphql',
    'rust',
  ])
    expect(hasBuiltInLanguageService(language)).toBe(false);
});
