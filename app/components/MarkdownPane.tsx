import { Image as ImageIcon, ListTree, MessageSquarePlus } from 'lucide-react';
import {
  createElement,
  type HTMLAttributes,
  useDeferredValue,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import Markdown, { type ExtraProps } from 'react-markdown';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import {
  extractMarkdownHeadings,
  markdownHeadingReference,
  safeMarkdownLink,
} from '@/lib/markdown';
import type { ContextReference, SourceRange } from '@/lib/types';
import { Button } from './ui/button';
import { Tooltip } from './ui/tooltip';
import './markdown-pane.css';

export interface MarkdownPaneProps {
  content: string;
  path: string;
  onNavigateHeading: (range: SourceRange) => void;
  onAttachHeading: (reference: ContextReference) => void;
  onOpenLink: (href: string) => void;
}

export function MarkdownPane({
  content,
  path,
  onNavigateHeading,
  onAttachHeading,
  onOpenLink,
}: MarkdownPaneProps) {
  const draft = useMemo(() => ({ path, content }), [path, content]);
  const deferred = useDeferredValue(draft);
  const source = deferred.path === path ? deferred.content : content;
  const headings = useMemo(() => extractMarkdownHeadings(source), [source]);
  const headingIds = useMemo(
    () => new Map(headings.map((heading) => [heading.range.start.line, heading.id])),
    [headings],
  );
  const preview = useRef<HTMLDivElement>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const outlineId = useId();
  function followLink(value?: string) {
    const href = safeMarkdownLink(value);
    if (!href) return;
    if (href.startsWith('#')) {
      let id: string;
      try {
        id = decodeURIComponent(href.slice(1));
      } catch {
        return;
      }
      const heading = headings.find((item) => item.id === id);
      if (heading) {
        onNavigateHeading(heading.range);
        preview.current
          ?.querySelector(`[data-heading-id="${CSS.escape(id)}"]`)
          ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
      return;
    }
    onOpenLink(href);
  }
  const renderHeading =
    (depth: number) =>
    ({ node, children }: HTMLAttributes<HTMLHeadingElement> & ExtraProps) => {
      const id = headingIds.get((node?.position?.start.line || 0) - 1);
      return createElement(`h${depth}`, { 'data-heading-id': id }, children);
    };
  return (
    <section className="markdown-pane" aria-label="Markdown preview">
      {!!headings.length && (
        <div className="markdown-pane-toolbar" role="toolbar" aria-label="Preview actions">
          <Tooltip label={outlineOpen ? 'Hide outline' : 'Show outline'}>
            <Button
              variant="ghost"
              size="icon"
              className="markdown-outline-toggle"
              aria-label="Outline"
              aria-expanded={outlineOpen}
              aria-controls={outlineId}
              onClick={() => setOutlineOpen((open) => !open)}
            >
              <ListTree size={14} aria-hidden="true" />
            </Button>
          </Tooltip>
        </div>
      )}
      <div className="markdown-pane-body">
        {!!headings.length && (
          <nav
            id={outlineId}
            className="markdown-outline"
            aria-label="Markdown headings"
            hidden={!outlineOpen}
          >
            <ol>
              {headings.map((heading) => (
                <li className="markdown-outline-row" key={heading.id}>
                  <button
                    type="button"
                    className="markdown-outline-link"
                    style={{ paddingInlineStart: (heading.depth - 1) * 10 }}
                    title={`Go to ${heading.text}`}
                    onClick={() => onNavigateHeading(heading.range)}
                  >
                    {heading.text || 'Untitled heading'}
                  </button>
                  <Tooltip label="Add section to chat">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Add ${heading.text || 'section'} to chat`}
                      onClick={() =>
                        onAttachHeading(markdownHeadingReference(heading, path, source))
                      }
                    >
                      <MessageSquarePlus size={12} />
                    </Button>
                  </Tooltip>
                </li>
              ))}
            </ol>
          </nav>
        )}
        <div className="markdown markdown-preview" ref={preview}>
          <div className="markdown-preview-content">
            <Markdown
              remarkPlugins={[remarkGfm, remarkFrontmatter]}
              skipHtml
              urlTransform={(url) => safeMarkdownLink(url) || ''}
              components={{
                h1: renderHeading(1),
                h2: renderHeading(2),
                h3: renderHeading(3),
                h4: renderHeading(4),
                h5: renderHeading(5),
                h6: renderHeading(6),
                a: ({ href, children }) => (
                  <button
                    type="button"
                    className="source-link"
                    disabled={!safeMarkdownLink(href)}
                    onClick={() => followLink(href)}
                  >
                    {children}
                  </button>
                ),
                img: ({ alt }) => (
                  <span className="markdown-image">
                    <ImageIcon size={14} />
                    {alt || 'Image'}
                  </span>
                ),
              }}
            >
              {source}
            </Markdown>
          </div>
        </div>
      </div>
    </section>
  );
}
