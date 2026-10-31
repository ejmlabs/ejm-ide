import { Button } from '@ejm/ui/components/ui/button';
import { Hero } from '@ejm/ui/layout/Hero';

export default function NotFound() {
  return (
    <Hero
      eyebrow="404"
      title="That page is not here."
      actions={
        <Button asChild>
          <a href="/">Go to ejm-ide</a>
        </Button>
      }
    >
      <p>Head back to ejm-ide to see the editor and its downloads.</p>
    </Hero>
  );
}
