import { Analytics } from '@ejm/site/analytics';
import { otherSites, PROJECTS, sourceLinks } from '@ejm/site/projects';
import { Link, usePath } from '@ejm/ssg';
import logoInk from '@ejm/tokens/assets/projects/ide/mark-ink.svg?url&no-inline';
import logoPaper from '@ejm/tokens/assets/projects/ide/mark-paper.svg?url&no-inline';
import { type FooterProps, type NavItem, SiteLayout } from '@ejm/ui/shell';
import type { ReactNode } from 'react';

const here = PROJECTS.ide;

const pages = [
  { label: 'Download', href: '/download/' },
  { label: 'Docs', href: '/docs/' },
];

const footer: FooterProps = {
  identity: {
    name: here.name,
    artwork: { src: logoInk, darkSrc: logoPaper, width: 40, height: 40 },
    description: 'An open-source desktop editor with Edi, under MIT.',
  },
  columns: [
    {
      heading: 'ejm-ide',
      links: [
        { label: 'Home', href: '/' },
        { label: 'Download', href: '/download/' },
        { label: 'Documentation', href: '/docs/' },
        { label: 'User guide', href: '/docs/user-guide/' },
        { label: 'Developer guide', href: '/docs/developer-guide/' },
      ],
    },
    { heading: 'Sites', links: otherSites('ide') },
    {
      heading: 'Source and legal',
      links: [
        ...sourceLinks('ide'),
        { label: 'Website privacy', href: 'https://ejmlabs.com/privacy/', external: true },
        { label: 'MIT license', href: '/license.txt' },
        { label: 'Notices', href: '/notices.txt' },
      ],
    },
  ],
  privacy:
    'Visits are counted with Cloudflare Web Analytics, which sets no cookies and is off when your browser sends Do Not Track or Global Privacy Control. The only cookie is your theme choice.',
  legal: 'ejmlabs. ejm-ide is released under the MIT license.',
};

/** The page frame for every route: skip link, header with the theme toggle last, the page, the footer, and analytics. */
export function App({ children }: { children: ReactNode }) {
  const path = usePath();
  const nav: NavItem[] = [
    ...pages.map((p) => ({
      ...p,
      current:
        p.href === '/docs/' ? path.startsWith('/docs') : path.startsWith(p.href.replace(/\/$/, '')),
    })),
    { label: 'Source', href: here.repo, external: true },
  ];
  return (
    <>
      <SiteLayout
        header={{
          identity: {
            name: here.name,
            artwork: { src: logoInk, darkSrc: logoPaper, width: 40, height: 40 },
          },
          homeLabel: 'ejm-ide home',
          nav,
        }}
        footer={footer}
        linkComponent={Link}
      >
        {children}
      </SiteLayout>
      <Analytics />
    </>
  );
}
