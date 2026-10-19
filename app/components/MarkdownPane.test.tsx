import { Provider as TooltipProvider } from '@radix-ui/react-tooltip';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { MarkdownPane } from './MarkdownPane';

it('renders GFM with inert images, blocked executable links, and no raw HTML', () => {
  const content = [
    '# Guide',
    '',
    '![Private diagram](https://remote.example/tracking.png)',
    '',
    '[unsafe](javascript:alert%281%29)',
    '',
    '<script>alert(1)</script>',
    '',
    '| Tool | State |',
    '| --- | --- |',
    '| ejm-ide | Ready |',
  ].join('\n');
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <MarkdownPane
        path="/workspace/guide.md"
        content={content}
        onNavigateHeading={vi.fn()}
        onAttachHeading={vi.fn()}
        onOpenLink={vi.fn()}
      />
    </TooltipProvider>,
  );
  expect(html).toContain('Private diagram');
  expect(html).toContain('<table>');
  expect(html).toContain('Add Guide to chat');
  expect(html).not.toMatch(/<(?:img|script|link)\b/);
  expect(html).not.toContain('https://remote.example');
  expect(html).not.toContain('javascript:');
});

it('keeps the outline collapsed until requested and removes the rail for unstructured text', () => {
  const render = (content: string) =>
    renderToStaticMarkup(
      <TooltipProvider>
        <MarkdownPane
          path="/workspace/notes.md"
          content={content}
          onNavigateHeading={vi.fn()}
          onAttachHeading={vi.fn()}
          onOpenLink={vi.fn()}
        />
      </TooltipProvider>,
    );
  const headed = render('# Notes\n\nA short note.');
  expect(headed).toContain('aria-expanded="false"');
  expect(headed).toContain('aria-label="Outline"');
  expect(headed).toMatch(/<nav[^>]+aria-label="Markdown headings"[^>]+hidden=""/);
  expect(headed).toContain('Add Notes to chat');
  const plain = render('A short note without headings.');
  expect(plain).not.toContain('markdown-outline');
  expect(plain).not.toContain('role="toolbar"');
  expect(plain).not.toContain('No headings');
  expect(plain).toContain('A short note without headings.');
});

it('uses the editor tab for document identity and reserves the surface for reading', () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <MarkdownPane
        path="/workspace/project/architecture.md"
        content={'# Architecture\n\nRead the [API guide](./api.md).'}
        onNavigateHeading={vi.fn()}
        onAttachHeading={vi.fn()}
        onOpenLink={vi.fn()}
      />
    </TooltipProvider>,
  );
  expect(html).toContain('aria-label="Markdown preview"');
  expect(html).toContain('markdown-preview-content');
  expect(html).toContain('data-heading-id="architecture"');
  expect(html).toContain('API guide');
  expect(html).not.toContain('<header');
  expect(html).not.toContain('architecture.md');
  expect(html).not.toContain('>Preview<');
});
