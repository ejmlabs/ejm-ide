import { Static } from '@ejm/ssg';
import { type ClientDocPage, DocsPage, docNavigation, type FullDocPage } from '@ejm/ui/docs';
import { Band } from '@ejm/ui/layout';
import { requiresRich } from '../generated/docs-build';
import nav from '../generated/docs-nav.json';

const DocProse =
  import.meta.env.SSR || import.meta.env.DEV
    ? (await import('@ejm/ui/docs/DocProse')).DocProse
    : undefined;
const CodeHighlight =
  import.meta.env.SSR || import.meta.env.DEV
    ? (await import('@ejm/ui/docs/CodeHighlight')).CodeHighlight
    : undefined;

const DocDataBlock = requiresRich
  ? (await import('@ejm/ui/docs/DocDataBlock')).DocDataBlock
  : undefined;

/** Product routes and guide order compose the shared docs shell and prose renderer. */
export function DocsPageView({ data, prose }: { data: ClientDocPage; prose?: FullDocPage }) {
  const href = data.slug ? `/docs/${data.slug}/` : '/docs/';
  return (
    <Band flush column={false}>
      <DocsPage
        page={data}
        {...docNavigation(nav, href)}
        staticBoundary={Static}
        renderBlock={
          DocDataBlock
            ? (block, renderCode) => <DocDataBlock block={block} renderCode={renderCode} />
            : undefined
        }
        renderCode={
          CodeHighlight
            ? (block) => <CodeHighlight code={block.code} lang={block.lang} label={block.label} />
            : undefined
        }
        renderProse={
          DocProse && prose
            ? (sectionIndex, itemIndex) => {
                const section = prose.sections[sectionIndex];
                const item = section?.items[itemIndex];
                if (!section || item?.type !== 'prose')
                  throw new Error('Documentation data does not match its static prose.');
                return <DocProse section={section} blocks={item.blocks} first={itemIndex === 0} />;
              }
            : undefined
        }
      />
    </Band>
  );
}
