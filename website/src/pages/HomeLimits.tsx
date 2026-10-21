import { Band, SectionHead, Stat } from '@ejm/ui/layout';
import { MetricGrid, Note, SectionBody } from '@ejm/ui/layout/SiteContent';

export default function HomeLimits() {
  return (
    <Band tone="paper" id="limits" aria-labelledby="limits-title">
      <SectionHead title="Index and call graph limits." id="limits-title">
        <p>
          Semantic links come from language servers. Links from the local index are labelled
          inferred, and partial results say so instead of hiding the gap.
        </p>
      </SectionHead>
      <SectionBody>
        <MetricGrid>
          <Stat figure="6" label="languages with first-class support" />
          <Stat figure="2" label="levels deep when a call graph first opens" />
          <Stat figure="40" label="new symbols at most in that first batch" />
          <Stat figure="20" label="more symbols per More callers or More callees click" />
        </MetricGrid>
      </SectionBody>
      <Note>
        These defaults keep the first graph small. Reveal more branches as you explore. Graphs show
        static relationships and can miss calls resolved at runtime.
      </Note>
    </Band>
  );
}
