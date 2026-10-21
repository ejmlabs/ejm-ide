import { Band, SectionHead } from '@ejm/ui/layout';
import { InlineLink } from '@ejm/ui/layout/InlineLink';

export default function NotFound() {
  return (
    <Band>
      <SectionHead as="h1" kicker="404" title="That page is not here." purpose="page">
        <p>
          Head back to <InlineLink href="/">ejm-ide</InlineLink> or read the{' '}
          <InlineLink href="/docs/">documentation</InlineLink>.
        </p>
      </SectionHead>
    </Band>
  );
}
