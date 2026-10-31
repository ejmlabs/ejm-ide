import { LazyIdeDemo } from '@ejm/demos/islands/ide-lazy';
import {
  Button,
  Callout,
  CodeBlock,
  Hero,
  Row,
  Rows,
  Section,
  Stat,
  Table,
  type TableColumn,
} from '@ejm/ui';
import {
  Actions,
  Columns,
  ContentGroup,
  ContentHeading,
  InlineCode,
  MetricGrid,
  Note,
} from '@ejm/ui/layout/SiteContent';
import { Downloads, hasRelease, useReleases } from '../downloads';

const features = [
  {
    title: 'Source comes first',
    description:
      'A Monaco editor in resizable groups, with one tab bar per group and movable tabs. Source, diffs and Markdown previews share the main editor.',
  },
  {
    title: 'Follow the whole story',
    description:
      'Definitions, implementations, references, callers and callees come from your language servers. Links from the local index are labelled inferred.',
  },
  {
    title: 'A call graph you steer',
    description:
      'The graph for the selected method starts shallow. More callers and More callees on a node reveal the next branch.',
  },
  {
    title: 'Git in the workspace',
    description:
      'Stage files, commit the reviewed index, search a paginated commit graph, and follow file history and blame, including unsaved text.',
  },
  {
    title: 'Edi, an agent you can inspect',
    description:
      'Tool progress, arguments, results and recorded file diffs appear in chat. A Debug inspector shows agent timing, failures and limits.',
  },
  {
    title: 'Split editors',
    description: 'Open several editor groups side by side and move tabs between them.',
  },
];

const keyColumns: readonly TableColumn[] = [
  { key: 'key', label: 'Key' },
  { key: 'action', label: 'Action' },
];

const keys = [
  ['⌘ K', 'Search files and commands'],
  ['⌘ P', 'Go to file'],
  ['⌘ L', 'Add the selection to chat'],
  ['Tab', 'Accept a prediction'],
].map(([key, action]) => ({ id: key, key: <InlineCode>{key}</InlineCode>, action }));

const languages = `# code insight
Rust        rust-analyzer
Python      Pyright
TypeScript  TypeScript Language Server
Ruby        Ruby LSP
Go          gopls
Markdown    heading outline, live preview

# on save, separate switches
format      rustfmt, Ruff, Biome, gofmt, remark
lint        Clippy, Ruff, Biome, RuboCop, remark-lint`;

const providerColumns: readonly TableColumn[] = [
  { key: 'provider', label: 'Provider' },
  { key: 'connect', label: 'How to connect it' },
];

const providers = [
  ['OpenAI compatible', 'Add a provider profile for any compatible endpoint.'],
  ['OpenAI Responses', 'Native Responses transport through the shared ejm-harness engine.'],
  ['ChatGPT', 'Sign in with your ChatGPT subscription from the connection setup.'],
  [
    'Anthropic',
    'Anthropic provider profiles with an explicit model and the same native key storage.',
  ],
].map(([provider, connect]) => ({ id: provider, provider, connect }));

export default function Home() {
  const releases = useReleases();
  const released = hasRelease(releases.state);
  return (
    <>
      <Hero
        eyebrow="desktop"
        title="ejm-ide keeps you in the code."
        actions={
          <>
            <Button asChild>
              <a href="#get">{released ? 'Download ejm-ide' : 'View downloads'}</a>
            </Button>
            <Button asChild variant="secondary">
              <a href="#how">What it does</a>
            </Button>
          </>
        }
        footnote={released ? 'Installers are listed below' : 'Desktop releases in development'}
      >
        A free, open-source desktop editor built in Rust. Precise code navigation, split editors,
        and an agent beside you, with every tool call and diff in view.
      </Hero>

      <Section
        id="try"
        kicker="ejm-ide"
        title="Try ejm-ide in your browser."
        intro="A scripted simulation of the editor with Edi beside it. Open files, ask for a change, then accept or reject the proposed diff."
      >
        <LazyIdeDemo />
      </Section>

      <Section
        id="editor"
        kicker="the app"
        title="The editor, with the agent beside it."
        intro="A project tree, Markdown source and preview side by side, and the chat pane open on the right."
      >
        <figure>
          <img
            src="/editor.jpg"
            width="1280"
            height="800"
            alt="ejm-ide with a project tree, Markdown source and preview side by side, and the chat pane open on the right."
            loading="lazy"
            decoding="async"
          />
          <figcaption>
            <Note>
              The actual app, running the built-in sample project in browser preview. No provider is
              connected, so Edi, the chat agent, shows its sign-in prompt.
            </Note>
          </figcaption>
        </figure>
      </Section>

      <Section
        id="how"
        kicker="what it does"
        title="Built around the code you write."
        intro="Both themes use the ejmlabs palette. Preferences picks System, Light or Dark, and the editor theme follows."
      >
        <Rows aria-label="What ejm-ide does">
          {features.map((f) => (
            <Row key={f.title} title={f.title} description={f.description} />
          ))}
        </Rows>
      </Section>

      <Section
        id="keys"
        kicker="keys"
        title="Four shortcuts to start."
        intro="Search finds files and commands, and the other three keep you in the editor and the chat."
      >
        <Table
          label="Main keys"
          caption="Main keys in ejm-ide on macOS"
          columns={keyColumns}
          rows={keys}
          rowHeader="key"
          rowKey="id"
          truncate={false}
        />
      </Section>

      <Section
        id="languages"
        kicker="languages"
        title="Language servers do the reading."
        intro="ejm-ide starts a server when you open the first file of a language, and sends unsaved text to it before each lookup. Hover, completion, definitions and formatting follow what the server advertises."
      >
        <Columns
          primary={
            <ContentGroup>
              <ContentHeading>Open the project root.</ContentHeading>
              <p>
                Servers read your build files from the root. Ruby LSP does not advertise call
                hierarchy, so Ruby graphs rely on the local index and say so.
              </p>
            </ContentGroup>
          }
          secondary={
            <CodeBlock
              code={languages}
              label="Language servers and tools by language"
              copyable={false}
            />
          }
        />
      </Section>

      <Section
        id="limits"
        kicker="limits"
        title="Honest about what it knows."
        intro="Semantic links come from language servers. Links from the local index are labelled inferred, and partial results say so instead of hiding the gap."
      >
        <MetricGrid>
          <Stat figure="6" label="languages with first-class support" />
          <Stat figure="2" label="levels deep when a call graph first opens" />
          <Stat figure="40" label="new symbols at most in that first batch" />
          <Stat figure="20" label="more symbols per More callers or More callees click" />
        </MetricGrid>
        <Callout>
          These are the documented defaults of the current build, taken from the project's language
          guide. They are limits, not speed measurements. No benchmark against other editors has
          run, and a finished crawl shows static relationships, not proof of every runtime call.
        </Callout>
      </Section>

      <Section
        id="models"
        kicker="models"
        title="Bring your own model."
        intro="The agent runs on the shared ejm-harness engine. Keys go to native storage, scoped to that provider."
      >
        <Table
          label="Supported providers"
          caption="Providers and how to connect each"
          columns={providerColumns}
          rows={providers}
          rowHeader="provider"
          rowKey="id"
          truncate={false}
        />
      </Section>

      <Section
        id="get"
        kicker="downloads"
        title="Get ejm-ide."
        intro="ejm-ide is free and MIT licensed. Connect a supported subscription or API key when you want to use AI. Your provider's usage terms and charges apply."
      >
        <Downloads state={releases.state} retry={releases.retry} />
        <Note>
          macOS is the current development target. A platform appears here only after its installer
          is built, signed and verified.
        </Note>
      </Section>

      <Section
        title="Built on an open engine."
        emphasis
        intro="Edi, the agent in ejm-ide, runs on ejm-harness, the open Rust engine that also powers ejm-cli."
        actions={
          <Actions>
            <Button asChild>
              <a href="https://harness.ejmlabs.com/" rel="external">
                Read about ejm-harness
              </a>
            </Button>
            <Button asChild variant="secondary">
              <a href="https://cli.ejmlabs.com/" rel="external">
                Try ejm-cli
              </a>
            </Button>
          </Actions>
        }
      />
    </>
  );
}
