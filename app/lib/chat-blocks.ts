export type ChatScalar = string | number | boolean | null;
export interface MarkdownBlock {
  type: 'markdown';
  text: string;
}
export interface CalloutBlock {
  type: 'callout';
  tone: 'info' | 'success' | 'warning';
  title?: string;
  text: string;
}
export interface TableBlock {
  type: 'table';
  columns: { key: string; label: string }[];
  rows: Record<string, ChatScalar>[];
  caption?: string;
}
export interface ChartBlock {
  type: 'chart';
  kind: 'bar' | 'line';
  title?: string;
  xKey: string;
  series: { key: string; label: string }[];
  data: Record<string, string | number | null>[];
  xLabel?: string;
  yLabel?: string;
}
export interface DiagramBlock {
  type: 'diagram';
  title?: string;
  nodes: { id: string; label: string }[];
  edges: { from: string; to: string; label?: string }[];
  direction?: 'LR' | 'TB';
}
export type ChatBlock = MarkdownBlock | CalloutBlock | TableBlock | ChartBlock | DiagramBlock;
export interface ChatPresentation {
  id: string;
  title: string;
  blocks: ChatBlock[];
}

const MAX_BYTES = 128 * 1024;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function invalid(): never {
  throw new Error('Invalid chat presentation.');
}

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  if (Object.keys(value).some((key) => !fields.includes(key))) invalid();
  return value as Record<string, unknown>;
}

function items(value: unknown, maximum: number, minimum = 0): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) invalid();
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) invalid();
  }
  return value;
}

function unique(values: string[]): Set<string> {
  const result = new Set(values);
  if (result.size !== values.length) invalid();
  return result;
}

export function parseChatPresentation(value: unknown): ChatPresentation | null {
  let bytes = 0;
  const encoder = new TextEncoder();
  function text(value: unknown, maximum = 256, nonempty = true): string {
    if (typeof value !== 'string' || value.length > maximum || (nonempty && !value.trim())) {
      invalid();
    }
    bytes += encoder.encode(value).byteLength;
    if (bytes > MAX_BYTES) invalid();
    return value;
  }
  function optionalText(value: unknown): string | undefined {
    return value === undefined ? undefined : text(value);
  }
  function identifier(value: unknown): string {
    const result = text(value, 64);
    if (!IDENTIFIER.test(result) || RESERVED_KEYS.has(result)) invalid();
    return result;
  }
  function scalar(value: unknown): ChatScalar {
    if (typeof value === 'string') return text(value, 4096, false);
    if (
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      bytes += String(value).length;
      if (bytes > MAX_BYTES) invalid();
      return value;
    }
    return invalid();
  }
  function block(value: unknown): ChatBlock {
    if (!value || typeof value !== 'object' || !('type' in value)) invalid();
    switch (value.type) {
      case 'markdown': {
        const input = record(value, ['type', 'text']);
        return { type: 'markdown', text: text(input.text, 32_768, false) };
      }
      case 'callout': {
        const input = record(value, ['type', 'tone', 'title', 'text']);
        if (input.tone !== 'info' && input.tone !== 'success' && input.tone !== 'warning')
          invalid();
        return {
          type: 'callout',
          tone: input.tone as CalloutBlock['tone'],
          title: optionalText(input.title),
          text: text(input.text, 32_768, false),
        };
      }
      case 'table': {
        const input = record(value, ['type', 'columns', 'rows', 'caption']);
        const columns = items(input.columns, 8, 1).map((value) => {
          const column = record(value, ['key', 'label']);
          return { key: identifier(column.key), label: text(column.label) };
        });
        const keys = [...unique(columns.map((column) => column.key))];
        const rows = items(input.rows, 100).map((value) => {
          const row = record(value, keys);
          return Object.fromEntries(
            Object.entries(row).map(([key, value]) => [key, scalar(value)]),
          );
        });
        return { type: 'table', columns, rows, caption: optionalText(input.caption) };
      }
      case 'chart': {
        const input = record(value, [
          'type',
          'kind',
          'title',
          'xKey',
          'series',
          'data',
          'xLabel',
          'yLabel',
        ]);
        if (input.kind !== 'bar' && input.kind !== 'line') invalid();
        const xKey = identifier(input.xKey);
        const series = items(input.series, 4, 1).map((value) => {
          const series = record(value, ['key', 'label']);
          return { key: identifier(series.key), label: text(series.label) };
        });
        const keys = [...unique([xKey, ...series.map((series) => series.key)])];
        const data = items(input.data, 100).map((value) => {
          const row = record(value, keys);
          return Object.fromEntries(
            keys.map((key) => {
              const value = Object.hasOwn(row, key) ? scalar(row[key]) : null;
              if (
                key === xKey
                  ? typeof value === 'boolean'
                  : value !== null && typeof value !== 'number'
              ) {
                invalid();
              }
              return [key, value as string | number | null];
            }),
          );
        });
        return {
          type: 'chart',
          kind: input.kind,
          title: optionalText(input.title),
          xKey,
          series,
          data,
          xLabel: optionalText(input.xLabel),
          yLabel: optionalText(input.yLabel),
        };
      }
      case 'diagram': {
        const input = record(value, ['type', 'title', 'nodes', 'edges', 'direction']);
        if (input.direction !== undefined && input.direction !== 'LR' && input.direction !== 'TB') {
          invalid();
        }
        const nodes = items(input.nodes, 40, 1).map((value) => {
          const node = record(value, ['id', 'label']);
          return { id: identifier(node.id), label: text(node.label) };
        });
        const ids = unique(nodes.map((node) => node.id));
        const edges = items(input.edges, 80).map((value) => {
          const edge = record(value, ['from', 'to', 'label']);
          const from = identifier(edge.from),
            to = identifier(edge.to);
          if (!ids.has(from) || !ids.has(to)) invalid();
          return { from, to, label: optionalText(edge.label) };
        });
        return {
          type: 'diagram',
          title: optionalText(input.title),
          nodes,
          edges,
          direction: input.direction as DiagramBlock['direction'],
        };
      }
      default:
        return invalid();
    }
  }
  try {
    const input = record(value, ['id', 'title', 'blocks']);
    const result = {
      id: identifier(input.id),
      title: text(input.title),
      blocks: items(input.blocks, 12, 1).map(block),
    };
    if (encoder.encode(JSON.stringify(result)).byteLength > MAX_BYTES) invalid();
    return result;
  } catch {
    return null;
  }
}
