import type { ClientDocPage, FullDocPage } from '@ejm/ui/docs';
import data from '../generated/docs-user-guide.json';
import { DocsPageView } from './docs';

const prose =
  import.meta.env.SSR || import.meta.env.DEV
    ? (await import('../generated/docs-user-guide-full.json')).default
    : undefined;

export default function UserGuide() {
  return <DocsPageView data={data as ClientDocPage} prose={prose as FullDocPage | undefined} />;
}
