import type { Nodes } from 'mdast';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkPresetLintRecommended from 'remark-preset-lint-recommended';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';
import { bufferVersion, fileUri, makeReference } from './context';
import type { ContextReference, DiagnosticEntry, SourceRange } from './types';

export interface MarkdownHeading {
  id: string;
  text: string;
  depth: number;
  range: SourceRange;
  sectionRange: SourceRange;
  content: string;
}

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter);
const formatter = parser().use(remarkStringify, {
  bullet: '-',
  emphasis: '*',
  fences: true,
  listItemIndent: 'one',
});
const linter = formatter().use(remarkPresetLintRecommended);

function headingText(node: Nodes): string {
  if (node.type === 'html') return '';
  if ('value' in node) return node.value;
  if ('alt' in node) return node.alt || '';
  return 'children' in node ? node.children.map(headingText).join('') : '';
}

export function extractMarkdownHeadings(content: string): MarkdownHeading[] {
  const nodes: { text: string; depth: number; range: SourceRange; offset: number }[] = [];
  function visit(node: Nodes) {
    if (node.type === 'heading' && node.position && node.position.start.offset !== undefined) {
      const { start, end } = node.position;
      nodes.push({
        text: headingText(node),
        depth: node.depth,
        range: {
          start: { line: start.line - 1, character: start.column - 1 },
          end: { line: end.line - 1, character: end.column - 1 },
        },
        offset: node.position.start.offset,
      });
    }
    if ('children' in node) node.children.forEach(visit);
  }
  visit(parser.parse(content));
  const lines = content.split('\n');
  const documentEnd = { line: lines.length - 1, character: lines.at(-1)?.length || 0 };
  const ends = nodes.map(() => ({ offset: content.length, position: documentEnd }));
  const stack: number[] = [];
  nodes.forEach((node, index) => {
    let previous = stack.at(-1);
    while (previous !== undefined && nodes[previous].depth >= node.depth) {
      ends[previous] = { offset: node.offset, position: node.range.start };
      stack.pop();
      previous = stack.at(-1);
    }
    stack.push(index);
  });
  const ids = new Set<string>();
  const suffixes = new Map<string, number>();
  return nodes.map((node, index) => {
    const text = node.text;
    const base =
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, '')
        .trim()
        .replace(/\s/g, '-') || 'section';
    let id = base;
    let suffix = suffixes.get(base) || 0;
    while (ids.has(id)) id = `${base}-${++suffix}`;
    suffixes.set(base, suffix);
    ids.add(id);
    return {
      id,
      text,
      depth: node.depth,
      range: node.range,
      sectionRange: { start: node.range.start, end: ends[index].position },
      content: content.slice(node.offset, ends[index].offset),
    };
  });
}

export function markdownHeadingReference(
  heading: MarkdownHeading,
  path: string,
  source: string,
): ContextReference {
  return makeReference({
    kind: 'symbol',
    label: heading.text,
    origin: 'Markdown outline',
    uri: fileUri(path),
    ranges: [heading.sectionRange],
    version: bufferVersion(source),
    content: heading.content,
  });
}

export function safeMarkdownLink(value?: string): string | undefined {
  const link = value?.trim();
  if (!link || link.startsWith('//') || link.startsWith('\\\\')) return undefined;
  for (const char of link)
    if (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(link) && !/^(?:https?|file|mailto):/i.test(link))
    return undefined;
  return link;
}

export function formatMarkdown(content: string): string {
  return String(formatter.processSync(content));
}

export function lintMarkdown(content: string, path: string): DiagnosticEntry[] {
  return linter.processSync(content).messages.map((message) => {
    const start = message.place && 'start' in message.place ? message.place.start : message.place;
    const end = message.place && 'end' in message.place ? message.place.end : start;
    const line = Math.max(0, (start?.line || 1) - 1);
    const character = Math.max(0, (start?.column || 1) - 1);
    return {
      uri: fileUri(path),
      source: 'remark-lint',
      code: message.ruleId || undefined,
      message: message.reason,
      severity: message.fatal ? 1 : 2,
      range: {
        start: { line, character },
        end: {
          line: Math.max(line, (end?.line || line + 1) - 1),
          character: Math.max(0, (end?.column || character + 2) - 1),
        },
      },
    };
  });
}
