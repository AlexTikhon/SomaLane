import type { RunAttention } from './run-attention.js';

const kindLabels: Record<RunAttention['kind'], string> = {
  attention: 'Needs attention',
  paused: 'Paused',
  pending: 'Synchronizing',
  recording: 'Recording',
};

/**
 * The compact Runner status shown above any other view (release step 3): what the run is doing now and the way back to
 * Runner. Presentation only; App derives `attention` from state it already owns.
 */
export function RunStatusNotice({ attention, onOpenRunner }: { attention: RunAttention; onOpenRunner: () => void }) {
  return (
    <section aria-label="Run status" className={`run-status run-status--${attention.kind}`} data-run-status={attention.kind}>
      <span aria-hidden="true" className="run-status__dot" />
      <div className="run-status__text">
        <p role="status">
          <strong>{kindLabels[attention.kind]}.</strong> {attention.headline}
        </p>
        {attention.detail !== '' && <p className="run-status__detail">{attention.detail}</p>}
      </div>
      <button onClick={onOpenRunner} type="button">Go to Runner</button>
    </section>
  );
}
