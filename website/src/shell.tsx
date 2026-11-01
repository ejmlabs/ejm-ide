import { Analytics } from '@ejm/site/analytics';
import { otherSites, PROJECTS, sourceLinks } from '@ejm/site/projects';
import { Link } from '@ejm/ssg';
import ideLogoInk from '@ejm/tokens/assets/projects/ide/mark-ink.svg?url&no-inline';
import ideLogoPaper from '@ejm/tokens/assets/projects/ide/mark-paper.svg?url&no-inline';
import { type FooterProps, type NavItem, SiteLayout } from '@ejm/ui/shell';
import type { ReactNode } from 'react';

const here = PROJECTS.ide;

const identity = {
  name: here.name,
  description: 'Small experiments. Useful things.',
  artwork: { src: ideLogoInk, darkSrc: ideLogoPaper, width: 40, height: 40 },
};

// Every section of the page, in order. The header shows them as a list where they fit and as its menu below that width.
const nav = [
  { label: 'Try it', href: '/#try' },
  { label: 'What it does', href: '/#how' },
  { label: 'Keys', href: '/#keys' },
  { label: 'Languages', href: '/#languages' },
  { label: 'Limits', href: '/#limits' },
  { label: 'Models', href: '/#models' },
  { label: 'Downloads', href: '/#get' },
] satisfies NavItem[];

const footer: FooterProps = {
  identity,
  columns: [
    {
      heading: 'Sites',
      links: [
        ...otherSites('ide'),
        { label: 'Brand kit', href: 'https://ejmlabs.com/brand/', external: true },
      ],
    },
    {
      heading: 'Source and legal',
      links: [
        ...sourceLinks('ide'),
        { label: 'MIT license', href: '/license.txt' },
        { label: 'Notices', href: '/notices.txt' },
        { label: 'Website privacy', href: 'https://ejmlabs.com/privacy/', external: true },
      ],
    },
  ],
  privacy:
    'Visits are counted with Cloudflare Web Analytics, which sets no cookies and is off when your browser sends Do Not Track or Global Privacy Control. The only cookie is your theme choice.',
  legal: '© 2026 ejmlabs. ejm-ide is released under the MIT license.',
};

/** The page frame for every route: skip link, header with the theme toggle last, the page, the footer, and analytics. */
export function App({ children }: { children: ReactNode }) {
  return (
    <>
      <SiteLayout
        header={{ identity, homeLabel: `${here.name} home`, nav }}
        footer={footer}
        linkComponent={Link}
      >
        {children}
      </SiteLayout>
      <Analytics />
    </>
  );
}
