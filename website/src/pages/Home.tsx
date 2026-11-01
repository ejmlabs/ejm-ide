import { LazyIdeDemo } from '@ejm/demos/islands/ide-lazy';
import { ShowcaseFrame } from '@ejm/demos/ShowcaseFrame';
import { PROJECTS } from '@ejm/site/projects';
import { Static } from '@ejm/ssg';
import { Button } from '@ejm/ui/components/ui/button';
import { Hero } from '@ejm/ui/layout/Hero';
import { Section } from '@ejm/ui/layout/Section';
import { ExternalLink } from '@ejm/ui/shell/ExternalLink';
import { Downloads } from '../Downloads';
import { useReleases } from '../useReleases';

const copy = import.meta.env.SSR || import.meta.env.DEV ? await import('./home.server') : undefined;

/** Fixed copy from home.server.tsx: in the built page, not in the browser bundle. */
function Copy({ part }: { part: keyof typeof import('./home.server') }) {
  const Part = copy?.[part];
  return <Static className="contents" render={Part ? () => <Part /> : undefined} />;
}

export default function Home() {
  const releases = useReleases();
  return (
    <>
      <Hero
        eyebrow="desktop"
        title="ejm-ide keeps you in the code."
        titleId="hero-title"
        actions={
          <>
            <Button asChild arrow>
              <a href="#get">{releases.published ? 'Download ejm-ide' : 'View downloads'}</a>
            </Button>
            <Button asChild variant="link">
              <a href="#how">What it does</a>
            </Button>
          </>
        }
        footnote={
          releases.published ? 'Installers are listed below' : 'Desktop releases in development'
        }
      >
        <Copy part="HeroIntro" />
      </Hero>
      <Section
        id="try"
        kicker="01 / ejm-ide"
        title="Try ejm-ide in your browser."
        intro={<Copy part="TryIntro" />}
      >
        <ShowcaseFrame
          label="ejm-ide example"
          note="Simulated demo. Nothing runs on your machine and nothing is sent anywhere. Edi's replies are scripted, and the editor is read only here."
        >
          <LazyIdeDemo />
        </ShowcaseFrame>
      </Section>
      <Section
        id="editor"
        kicker="02 / The app"
        title="The editor, with the agent beside it."
        intro={<Copy part="EditorIntro" />}
      >
        <Copy part="Editor" />
      </Section>
      <Section
        id="how"
        kicker="03 / What it does"
        title="Built around the code you write."
        intro={<Copy part="HowIntro" />}
      >
        <Copy part="How" />
      </Section>
      <Section
        id="keys"
        kicker="04 / Keys"
        title="Four shortcuts to start."
        intro={<Copy part="KeysIntro" />}
      >
        <Copy part="Keys" />
      </Section>
      <Section
        id="languages"
        kicker="05 / Languages"
        title="Language servers do the reading."
        intro={<Copy part="LanguagesIntro" />}
      >
        <Copy part="Languages" />
      </Section>
      <Section
        id="limits"
        kicker="06 / Limits"
        title="Honest about what it knows."
        intro={<Copy part="LimitsIntro" />}
      >
        <Copy part="Limits" />
      </Section>
      <Section
        id="models"
        kicker="07 / Models"
        title="Bring your own model."
        intro={<Copy part="ModelsIntro" />}
      >
        <Copy part="Models" />
      </Section>
      <Section
        id="get"
        kicker="08 / Downloads"
        title="Get ejm-ide."
        intro={<Copy part="DownloadsIntro" />}
      >
        <Downloads releases={releases}>
          <Copy part="DownloadsNote" />
        </Downloads>
      </Section>
      <Section
        emphasis
        title="Built on an open engine."
        intro={<Copy part="EngineIntro" />}
        actions={
          <>
            <ExternalLink href={PROJECTS.harness.url}>Read about ejm-harness</ExternalLink>
            <ExternalLink href={PROJECTS.cli.url}>Try ejm-cli</ExternalLink>
          </>
        }
      />
    </>
  );
}
