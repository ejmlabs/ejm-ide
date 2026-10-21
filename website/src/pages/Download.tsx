import { Button } from '@ejm/ui/components/ui/button';
import { Band, SectionHead } from '@ejm/ui/layout';
import { Actions, ContentFlow, InlineLink, Note, SectionBody } from '@ejm/ui/layout/SiteContent';
import { ExternalLink } from '@ejm/ui/shell';
import { ReleaseTable, releaseMessage, useReleases } from '../releases';

export default function Download() {
  const { state, manifest, platform, refresh } = useReleases();
  return (
    <Band>
      <SectionHead as="h1" title="ejm-ide installers." purpose="page">
        <p>
          Check availability for your platform. Downloads appear after each installer is built,
          signed and verified.
        </p>
      </SectionHead>
      <SectionBody>
        <ReleaseTable state={state} platform={platform} />
        <Actions>
          <ContentFlow role="status" aria-live="polite">
            <p>{releaseMessage(state, manifest)}</p>
            {state.status === 'error' && (
              <Button type="button" variant="link" onClick={refresh}>
                Try again
              </Button>
            )}
          </ContentFlow>
        </Actions>
        {manifest?.sourceUrl && (
          <Actions>
            <ExternalLink href={manifest.sourceUrl}>Source for this release</ExternalLink>
          </Actions>
        )}
        <Note>
          For a local build, follow the{' '}
          <InlineLink href="/docs/user-guide/#setup">source build guide</InlineLink>. Or{' '}
          <InlineLink href="/#try">watch the browser example</InlineLink> without a model
          connection.
        </Note>
        <noscript>
          <Note>Enable JavaScript to check for new installers.</Note>
        </noscript>
      </SectionBody>
    </Band>
  );
}
