// Server-only page copy. Shared Static keeps it out of the browser bundle.
import { Table } from '@ejm/ui/components/Table';
import { Callout } from '@ejm/ui/docs/Callout';
import { Fact, Facts } from '@ejm/ui/layout/Facts';
import { Row, Rows } from '@ejm/ui/layout/Rows';
import { Rule } from '@ejm/ui/layout/Rule';
import {
  Columns,
  ContentGroup,
  ContentHeading,
  MetricGrid,
  Note,
} from '@ejm/ui/layout/SiteContent';
import { Stat } from '@ejm/ui/layout/Stat';

export function HeroIntro() {
  return (
    <p>
      A free, open-source desktop editor built in Rust. Precise code navigation, split editors, and
      an agent beside you, with every tool call and diff in view.
    </p>
  );
}

export function TryIntro() {
  return (
    <p>
      A scripted simulation of the editor with Edi beside it. Open files, ask for a change, then
      accept or reject the proposed diff.
    </p>
  );
}

export function EditorIntro() {
  return (
    <p>
      A project tree, Markdown source and preview side by side, and the chat pane open on the right.
    </p>
  );
}

export function Editor() {
  return (
    <figure>
      <img
        src="/editor.jpg"
        width={1280}
        height={800}
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
  );
}

export function HowIntro() {
  return (
    <p>
      Both themes use the ejmlabs palette. Preferences picks System, Light or Dark, and the editor
      theme follows.
    </p>
  );
}

export function How() {
  return (
    <Rows aria-label="What ejm-ide does">
      <Row
        title="Source comes first"
        description="A Monaco editor in resizable groups, with one tab bar per group and movable tabs. Source, diffs and Markdown previews share the main editor."
      />
      <Row
        title="Follow the whole story"
        description="Definitions, implementations, references, callers and callees come from your language servers. Links from the local index are labelled inferred."
      />
      <Row
        title="A call graph you steer"
        description="The graph for the selected method starts shallow. More callers and More callees on a node reveal the next branch."
      />
      <Row
        title="Git in the workspace"
        description="Stage files, commit the reviewed index, search a paginated commit graph, and follow file history and blame, including unsaved text."
      />
      <Row
        title="Edi, an agent you can inspect"
        description="Tool progress, arguments, results and recorded file diffs appear in chat. A Debug inspector shows agent timing, failures and limits."
      />
      <Row
        title="Split editors"
        description="Open several editor groups side by side and move tabs between them."
      />
    </Rows>
  );
}

export function KeysIntro() {
  return (
    <p>Search finds files and commands, and the other three keep you in the editor and the chat.</p>
  );
}

export function Keys() {
  return (
    <Table
      label="Main keys"
      caption="Main keys in ejm-ide on macOS"
      columns={[
        { key: 'key', label: 'Key' },
        { key: 'action', label: 'Action' },
      ]}
      rows={[
        { key: <code>⌘ K</code>, action: 'Search files and commands' },
        { key: <code>⌘ P</code>, action: 'Go to file' },
        { key: <code>⌘ L</code>, action: 'Add the selection to chat' },
        { key: <code>Tab</code>, action: 'Accept a prediction' },
      ]}
      rowHeader="key"
      truncate={false}
    />
  );
}

export function LanguagesIntro() {
  return (
    <p>
      ejm-ide starts a server when you open the first file of a language, and sends unsaved text to
      it before each lookup. Hover, completion, definitions and formatting follow what the server
      advertises.
    </p>
  );
}

export function Languages() {
  return (
    <Columns
      primary={
        <ContentGroup>
          <ContentHeading>Open the project root.</ContentHeading>
          <p>
            Servers read your build files from the root. Ruby LSP does not advertise call hierarchy,
            so Ruby graphs rely on the local index and say so.
          </p>
        </ContentGroup>
      }
      secondary={
        <ContentGroup>
          <Rule label="code insight" />
          <Facts>
            <Fact label="Rust">rust-analyzer</Fact>
            <Fact label="Python">Pyright</Fact>
            <Fact label="TypeScript">TypeScript Language Server</Fact>
            <Fact label="Ruby">Ruby LSP</Fact>
            <Fact label="Go">gopls</Fact>
            <Fact label="Markdown">heading outline, live preview</Fact>
          </Facts>
          <Rule label="on save, separate switches" />
          <Facts>
            <Fact label="format">rustfmt, Ruff, Biome, gofmt, remark</Fact>
            <Fact label="lint">Clippy, Ruff, Biome, RuboCop, remark-lint</Fact>
          </Facts>
        </ContentGroup>
      }
    />
  );
}

export function LimitsIntro() {
  return (
    <p>
      Semantic links come from language servers. Links from the local index are labelled inferred,
      and partial results say so instead of hiding the gap.
    </p>
  );
}

export function Limits() {
  return (
    <>
      <MetricGrid>
        <Stat figure="6" label="languages with first-class support" />
        <Stat figure="2" label="levels deep when a call graph first opens" />
        <Stat figure="40" label="new symbols at most in that first batch" />
        <Stat figure="20" label="more symbols per More callers or More callees click" />
      </MetricGrid>
      <Callout kind="note">
        These are the documented defaults of the current build, taken from the project's language
        guide. They are limits, not speed measurements. No benchmark against other editors has run,
        and a finished crawl shows static relationships, not proof of every runtime call.
      </Callout>
    </>
  );
}

export function ModelsIntro() {
  return (
    <p>
      The agent runs on the shared ejm-harness engine. Keys go to native storage, scoped to that
      provider.
    </p>
  );
}

export function Models() {
  return (
    <Rows aria-label="Supported providers">
      <Row
        title="OpenAI compatible"
        description="Add a provider profile for any compatible endpoint."
      />
      <Row
        title="OpenAI Responses"
        description="Native Responses transport through the shared ejm-harness engine."
      />
      <Row
        title="ChatGPT"
        description="Sign in with your ChatGPT subscription from the connection setup."
      />
      <Row
        title="Anthropic"
        description="Anthropic provider profiles with an explicit model and the same native key storage."
      />
    </Rows>
  );
}

export function DownloadsIntro() {
  return (
    <p>
      ejm-ide is free and MIT licensed. Connect a supported subscription or API key when you want to
      use AI. Your provider's usage terms and charges apply.
    </p>
  );
}

export function DownloadsNote() {
  return (
    <Note>
      macOS is the current development target. A platform appears here only after its installer is
      built, signed and verified.
    </Note>
  );
}

export function EngineIntro() {
  return (
    <p>
      Edi, the agent in ejm-ide, runs on ejm-harness, the open Rust engine that also powers ejm-cli.
    </p>
  );
}
