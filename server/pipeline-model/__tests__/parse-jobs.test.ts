import { describe, it, expect } from 'vitest';
import { parseJobs } from '../parse-jobs';

describe('parseJobs', () => {
  it('extracts id/name/needs/if/uses/matrix and the workflow triggers', () => {
    const yaml = `
on:
  pull_request:
  merge_group:
jobs:
  build:
    name: "build: production"
    needs: [prepare]
    if: \${{ github.event_name != 'pull_request' }}
    runs-on: ubuntu-latest
  unit:
    name: "test: unit"
    uses: ./.github/workflows/_static.yml
    strategy:
      matrix:
        shard: [1, 2, 3]
`;
    const { triggers, jobs } = parseJobs(yaml);
    expect(triggers.events.map(e => e.kind)).toEqual(['pull_request', 'merge_group']);
    const build = jobs.find(j => j.id === 'build')!;
    expect(build).toMatchObject({
      id: 'build', name: 'build: production', needs: ['prepare'],
      if: "${{ github.event_name != 'pull_request' }}", uses: null,
    });
    const unit = jobs.find(j => j.id === 'unit')!;
    expect(unit).toMatchObject({ id: 'unit', uses: './.github/workflows/_static.yml' });
    expect(unit.matrix).toEqual({ shard: [1, 2, 3] });
  });

  it('normalizes a string `needs` to a single-element array and defaults', () => {
    const { jobs } = parseJobs(`jobs:\n  a:\n    needs: prepare\n  b: {}`);
    expect(jobs.find(j => j.id === 'a')!.needs).toEqual(['prepare']);
    expect(jobs.find(j => j.id === 'b')).toMatchObject({ needs: [], name: null, if: null, uses: null, matrix: null });
  });

  it('returns no jobs for an unparseable / jobless file (never throws)', () => {
    expect(parseJobs('not: a workflow').jobs).toEqual([]);
    expect(parseJobs(':::nonsense:::').jobs).toEqual([]);
  });

  // Fix #4: an empty-array matrix dimension is ignored (treated as no matrix)
  it('an empty-array matrix dimension is ignored, matrix becomes null', () => {
    const yaml = `
jobs:
  job-empty-dim:
    strategy:
      matrix:
        shard: []
`;
    const { jobs } = parseJobs(yaml);
    const job = jobs.find((j) => j.id === 'job-empty-dim')!;
    expect(job.matrix).toBeNull();
  });
});
