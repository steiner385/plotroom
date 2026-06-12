import type { PrView } from './types';

export type Bucket = 'running' | 'queued' | 'deploy' | 'failed' | 'idle';

/** Map a PrView to its status bucket. */
export function bucketPr(pr: PrView): Bucket {
  const { stage, substate } = pr.stage;
  if (stage === 'ci') return 'running';
  if (stage === 'queue') {
    if (substate === 'group-failed') return 'failed';
    return 'queued';
  }
  // qa-deploy / awaiting-prod only exist for repos with deploy environments;
  // bare 'merged' is the retention-window stage for repos WITHOUT deploys and
  // must not inflate the deploy ("Awaiting prod") tile.
  if (stage === 'qa-deploy' || stage === 'awaiting-prod') return 'deploy';
  if (stage === 'parked') {
    if (substate === 'ci-failed') return 'failed';
    return 'idle';
  }
  // ready + merged + any other parked substate
  return 'idle';
}

interface TileConfig { bucket: Bucket; label: string; cssClass: string; }

const TILES: TileConfig[] = [
  { bucket: 'running', label: 'CI running',     cssClass: 'tile-running' },
  { bucket: 'queued',  label: 'In queue',        cssClass: 'tile-queued' },
  { bucket: 'deploy',  label: 'Awaiting prod',   cssClass: 'tile-deploy' },
  { bucket: 'failed',  label: 'Failed',          cssClass: 'tile-failed' },
  { bucket: 'idle',    label: 'Ready / other',   cssClass: 'tile-idle'   },
];

interface StatusStripProps {
  prs: PrView[];
  activeFilter: Bucket | null;
  onFilter: (bucket: Bucket | null) => void;
}

export function StatusStrip({ prs, activeFilter, onFilter }: StatusStripProps) {
  const counts = new Map<Bucket, number>();
  for (const p of prs) {
    const b = bucketPr(p);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }

  return (
    <div className="status-strip" role="group" aria-label="Status overview">
      {TILES.map(({ bucket, label, cssClass }) => {
        const count = counts.get(bucket) ?? 0;
        const isActive = activeFilter === bucket;
        const disabled = count === 0 && !isActive;
        return (
          <button
            key={bucket}
            type="button"
            className={`status-tile ${cssClass}${isActive ? ' active' : ''}`}
            aria-pressed={isActive}
            disabled={disabled}
            onClick={() => onFilter(isActive ? null : bucket)}
          >
            <b>{count}</b>
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
