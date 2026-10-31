import { Analytics } from '@ejm/site/analytics';
import { otherSites, PROJECTS } from '@ejm/site/projects';
import { Link } from '@ejm/ssg';
import markInk from '@ejm/tokens/assets/projects/ide/mark-ink.svg?url';
import markPaper from '@ejm/tokens/assets/projects/ide/mark-paper.svg?url';
import { type FooterProps, SiteLayout } from '@ejm/ui';
import type { ReactNode } from 'react';

const here = PROJECTS.ide;
const identity = {
  name: here.name,
  artwork: { src: markInk, darkSrc: markPaper, width: 256, height: 256 },
};

const footer: FooterProps = {
  identity: { ...identity, description: here.tagline },
  columns: [
    { heading: 'Sites', links: otherSites('ide') },
    {
      heading: 'Legal',
      links: [
        { label: 'MIT license', href: '/license.txt' },
        { label: 'Notices', href: '/notices.txt' },
      ],
    },
  ],
  privacy:
    'Visits are counted with Cloudflare Web Analytics, which sets no cookies and is off when your browser sends Do Not Track or Global Privacy Control. The only cookie is your theme choice.',
  legal: '© 2026 ejmlabs. ejm-ide is released under the MIT license.',
};

/** The page frame: skip link, header with the theme toggle last, the page, the footer, and analytics. */
export function App({ children }: { children: ReactNode }) {
  return (
    <>
      <SiteLayout
        header={{ identity, homeLabel: `${here.name} home` }}
        footer={footer}
        linkComponent={Link}
      >
        {children}
      </SiteLayout>
      <Analytics />
    </>
  );
}
