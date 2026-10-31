import { Hero } from '@ejm/ui';
import { InlineLink } from '@ejm/ui/layout/SiteContent';

export default function NotFound() {
  return (
    <Hero
      eyebrow="404"
      title="That page is not here."
      actions={<InlineLink href="/">Back to ejm-ide</InlineLink>}
    >
      Head back to ejm-ide to see the editor and its downloads.
    </Hero>
  );
}
