import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
export function basename(path: string) {
  return path.split(/[\\/]/).pop() || path;
}
export function relativePath(path: string, root: string) {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
export function languageId(path: string) {
  const name = basename(path);
  if (['Gemfile', 'Rakefile', 'Guardfile', 'Brewfile'].includes(name)) return 'ruby';
  const lower = name.toLowerCase();
  if (/^(dockerfile|containerfile)(\..+)?$/.test(lower)) return 'dockerfile';
  if (
    [
      '.bashrc',
      '.bash_profile',
      '.bash_login',
      '.bash_logout',
      '.profile',
      '.zshrc',
      '.zshenv',
      '.zprofile',
      '.zlogin',
      '.zlogout',
      '.kshrc',
    ].includes(lower)
  )
    return 'shell';
  if (['cargo.lock', 'pipfile', 'poetry.lock', 'uv.lock', 'pdm.lock'].includes(lower))
    return 'toml';
  if (['.editorconfig', '.gitconfig', '.npmrc'].includes(lower) || /^\.env(?:\..+)?$/.test(lower))
    return 'ini';
  if (isJsonComments(path)) return 'json';
  const dot = name.lastIndexOf('.');
  const ext = dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
  return (
    (
      {
        rs: 'rust',
        py: 'python',
        pyi: 'python',
        rb: 'ruby',
        rake: 'ruby',
        gemspec: 'ruby',
        ru: 'ruby',
        go: 'go',
        ts: 'typescript',
        tsx: 'typescript',
        mts: 'typescript',
        cts: 'typescript',
        js: 'javascript',
        jsx: 'javascript',
        mjs: 'javascript',
        cjs: 'javascript',
        json: 'json',
        toml: 'toml',
        md: 'markdown',
        markdown: 'markdown',
        html: 'html',
        htm: 'html',
        css: 'css',
        scss: 'scss',
        less: 'less',
        yml: 'yaml',
        yaml: 'yaml',
        sh: 'shell',
        bash: 'shell',
        zsh: 'shell',
        ksh: 'shell',
        sql: 'sql',
        xml: 'xml',
        svg: 'xml',
        xsd: 'xml',
        xsl: 'xml',
        xslt: 'xml',
        plist: 'xml',
        dockerfile: 'dockerfile',
        graphql: 'graphql',
        gql: 'graphql',
        ini: 'ini',
        cfg: 'ini',
        conf: 'ini',
        properties: 'ini',
      } as Record<string, string>
    )[ext || ''] || 'plaintext'
  );
}

export function isJsonComments(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').toLowerCase();
  const name = basename(normalized);
  return (
    /\.(jsonc|code-workspace|code-snippets)$/.test(name) ||
    /^(tsconfig|jsconfig)(\..+)?\.json$/.test(name) ||
    /(?:^|\/)\.vscode\/(settings|launch|tasks|extensions)\.json$/.test(normalized)
  );
}

export function hasBuiltInLanguageService(language: string): boolean {
  return ['json', 'html', 'css', 'scss', 'less'].includes(language);
}
