import { LazyIdePreview } from '@ejm/demos/islands/ide-preview';
import { ShowcaseFrame } from '@ejm/demos/ShowcaseFrame';
import { PROJECTS } from '@ejm/site/projects';
import { Link, Static } from '@ejm/ssg';
import { Button } from '@ejm/ui/components/ui/button';
import { Band, Fact, Facts, Hero, Row, Rows, SectionHead } from '@ejm/ui/layout';
import {
  Columns,
  ContentFlow,
  ContentGroup,
  ContentHeading,
  InlineLink,
  Note,
  SectionBody,
} from '@ejm/ui/layout/SiteContent';
import { ExternalLink } from '@ejm/ui/shell';
import { releaseMessage, useReleases } from '../releases';

const HomeLimits =
  import.meta.env.SSR || import.meta.env.DEV ? (await import('./HomeLimits')).default : undefined;

const features = [
  [
    'Source editing',
    'A Monaco editor in resizable groups, with one tab bar per group and movable tabs. Source, diffs and Markdown previews share the main editor.',
  ],
  [
    'Code navigation',
    'Definitions, implementations, references, callers and callees come from your language servers. Links from the local index are labelled inferred.',
  ],
  [
    'Call hierarchy',
    'The graph for the selected method starts shallow. More callers and More callees on a node reveal the next branch.',
  ],
  [
    'Git in the workspace',
    'Stage files, commit staged changes, search commit history, and follow file history and blame, including unsaved text.',
  ],
  [
    'Agent tools and diffs',
    'Tool progress, arguments, results and recorded file diffs appear in chat. A Debug inspector shows agent timing, failures and limits.',
  ],
] as const;

const insight = [
  ['Rust', 'rust-analyzer'],
  ['Python', 'Pyright'],
  ['TypeScript', 'TypeScript Language Server'],
  ['Ruby', 'Ruby LSP'],
  ['Go', 'gopls'],
  ['Markdown', 'Heading outline and live preview'],
] as const;

export default function Home() {
  const { state, manifest, anyRelease } = useReleases();
  return (
    <>
      <Hero
        titleId="home-title"
        eyebrow="ejm-ide / open source / MIT"
        title="An open-source desktop editor."
        actions={
          <>
            <Button asChild arrow>
              <Link href={anyRelease ? '/download/' : '#try'}>
                {anyRelease ? 'Download ejm-ide' : 'Watch the example'}
              </Link>
            </Button>
            <Button asChild variant="link">
              <ExternalLink href={PROJECTS.ide.repo}>Browse the source</ExternalLink>
            </Button>
          </>
        }
        footnote={
          anyRelease
            ? 'Installers are listed on the download page.'
            : 'Check the download page for installer status.'
        }
        aside={
          <ShowcaseFrame
            id="try"
            label="ejm-ide example session"
            note="Example session. Runs locally in your browser; no model connection."
          >
            <LazyIdePreview rootMargin="0px" />
          </ShowcaseFrame>
        }
      >
        <p>
          Edit source, follow language-server definitions and call graphs, review Git changes, and
          work with Edi in the same workspace. MIT licensed, built with React, Monaco, Tauri and
          Rust.
        </p>
      </Hero>

      <Band tone="sage" id="how" aria-labelledby="how-title">
        <SectionHead title="Editor and project tools." id="how-title" />
        <SectionBody>
          <Rows aria-label="What ejm-ide does">
            {features.map(([title, description]) => (
              <Row key={title} title={title} description={description} />
            ))}
          </Rows>
        </SectionBody>
      </Band>

      <Band tone="paper" id="keys" aria-labelledby="keys-title">
        <SectionHead title="Four shortcuts to start." id="keys-title">
          <p>
            Search finds files and commands, and the other three keep you in the editor and the
            chat.
          </p>
        </SectionHead>
        <SectionBody>
          <Facts>
            <Fact label="Cmd K">Search files and commands</Fact>
            <Fact label="Cmd P">Go to file</Fact>
            <Fact label="Cmd L">Add the selection to chat</Fact>
            <Fact label="Tab">Accept a prediction</Fact>
          </Facts>
        </SectionBody>
        <Note>Apple Silicon macOS is the current development target.</Note>
      </Band>

      <Band tone="mist" id="languages" aria-labelledby="languages-title">
        <SectionHead title="Language server support." id="languages-title">
          <p>
            ejm-ide starts a server when you open the first file of a language, and sends unsaved
            text to it before each lookup. Hover, completion, definitions and formatting follow what
            the server advertises.
          </p>
        </SectionHead>
        <SectionBody>
          <Columns
            primary={
              <ContentFlow>
                <ContentGroup>
                  <ContentHeading>Open the project root.</ContentHeading>
                  <p>
                    Servers read your build files from the root. Ruby LSP does not advertise call
                    hierarchy, so Ruby graphs rely on the local index and say so.
                  </p>
                </ContentGroup>
                <ContentGroup>
                  <ContentHeading>Format and lint on save.</ContentHeading>
                  <p>
                    Separate switches in Preferences. Format uses rustfmt, Ruff, Biome, gofmt and
                    remark. Lint uses Clippy, Ruff, Biome, RuboCop and remark-lint.
                  </p>
                </ContentGroup>
              </ContentFlow>
            }
            secondary={
              <Facts>
                {insight.map(([language, server]) => (
                  <Fact key={language} label={language}>
                    {server}
                  </Fact>
                ))}
              </Facts>
            }
          />
        </SectionBody>
      </Band>

      <Static render={HomeLimits ? () => <HomeLimits /> : undefined} />

      <Band tone="mist" id="models" aria-labelledby="models-title">
        <SectionHead title="Connect a model provider." id="models-title">
          <p>
            Edi uses the shared ejm-harness engine. Keys go to native storage, scoped to that
            provider. Your provider's usage terms and charges apply.
          </p>
        </SectionHead>
        <SectionBody>
          <Facts>
            <Fact label="OpenAI compatible">
              Add a provider profile for any compatible endpoint.
            </Fact>
            <Fact label="OpenAI Responses">
              Native Responses transport through the shared ejm-harness engine.
            </Fact>
            <Fact label="ChatGPT">
              Sign in with your ChatGPT subscription from the connection setup.
            </Fact>
            <Fact label="Anthropic">
              Anthropic provider profiles with an explicit model and the same native key storage.
            </Fact>
          </Facts>
        </SectionBody>
      </Band>

      <Band tone="sage" id="get" aria-labelledby="get-title">
        <SectionHead title="Build or install ejm-ide." id="get-title" />
        <SectionBody>
          <ContentFlow>
            <p role="status" aria-live="polite">
              {releaseMessage(state, manifest)}
            </p>
            <div>
              <Button asChild arrow>
                <Link href="/download/">View installer status</Link>
              </Button>
            </div>
            <p>
              Build the public source with the{' '}
              <InlineLink href="/docs/user-guide/#setup">source build guide</InlineLink>. It covers
              platform limits and the shared dependencies needed for a local build.
            </p>
          </ContentFlow>
        </SectionBody>
      </Band>

      <Band tone="paper" id="contribute" aria-labelledby="contribute-title">
        <SectionHead title="Help build ejm-ide." id="contribute-title">
          <p>
            Read the code, try a local build or improve a guide. Report a reproducible bug with its
            platform and steps, and keep pull requests small enough to review.
          </p>
        </SectionHead>
        <SectionBody>
          <Rows aria-label="Contribute to ejm-ide">
            <Row
              title="Build and extend"
              description="Set up the app, find a subsystem and run its checks."
              href="/docs/developer-guide/"
            />
            <Row
              title="Contribution guide"
              description="Find the project conventions and steps for opening a pull request."
              href={`${PROJECTS.ide.repo}/blob/main/CONTRIBUTING.md`}
              external
            />
            <Row
              title="Issues"
              description="Report bugs or discuss a proposed change."
              href={`${PROJECTS.ide.repo}/issues`}
              external
            />
          </Rows>
        </SectionBody>
      </Band>

      <Band tone="mist" aria-labelledby="engine-title">
        <SectionHead title="An engine shared with ejm-cli." id="engine-title">
          <p>
            Edi, the agent in ejm-ide, runs on ejm-harness, the open Rust engine that also powers
            ejm-cli.
          </p>
        </SectionHead>
        <SectionBody>
          <Rows aria-label="Related projects">
            <Row
              title="ejm-harness"
              description="The open Rust engine that runs the agent loop."
              meta="harness.ejmlabs.com"
              href="https://harness.ejmlabs.com/"
              external
            />
            <Row
              title="ejm-cli"
              description="A coding agent for your terminal, on the same engine."
              meta="cli.ejmlabs.com"
              href="https://cli.ejmlabs.com/"
              external
            />
          </Rows>
        </SectionBody>
      </Band>
    </>
  );
}
