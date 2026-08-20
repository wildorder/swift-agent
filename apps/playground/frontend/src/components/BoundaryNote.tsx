/**
 * The boundary-honesty line the page must carry: this hosted demo cannot
 * demonstrate the product's central claim that tools run on infrastructure the
 * visitor controls — here they run on the demo's own backend — and the copy
 * must never imply otherwise.
 */
export function BoundaryNote() {
  return (
    <p data-testid="boundary-note" style={{ maxWidth: '48rem' }}>
      Honesty note: the tools in this hosted demo run on the demo&apos;s own
      backend, not on visitor infrastructure. When you run the SDK yourself,
      your tools execute in your own process — reproduce this exact demo
      locally with the command in the source panel below.
    </p>
  );
}
