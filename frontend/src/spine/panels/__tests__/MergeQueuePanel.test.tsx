import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MergeQueuePanel } from '../MergeQueuePanel';
import type { DashboardState } from '../../../types';

const repos = (queue: object | null) =>
  [{ repo: 'acme/widgets', hasDeploy: false, prs: [], queue }] as unknown as DashboardState['repos'];

describe('MergeQueuePanel', () => {
  it('renders a QueueTrain for each repo with a queue and an empty note when none', () => {
    render(<MergeQueuePanel repos={repos({ groups: [{ oid: 'g1', prNumbers: [1], percent: 50, etaSeconds: 60, failed: false }], waiting: [], batchSize: 6 })} />);
    expect(screen.getByText(/group/i)).toBeInTheDocument();   // QueueTrain renders a building-group car
  });
  it('shows an empty note when no repo has a queue', () => {
    render(<MergeQueuePanel repos={repos(null)} />);
    expect(screen.getByText(/queue is empty/i)).toBeInTheDocument();
  });
});
