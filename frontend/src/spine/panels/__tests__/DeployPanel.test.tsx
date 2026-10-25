import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DeployPanel } from '../DeployPanel';
import type { DashboardState } from '../../../types';

const repos = (deploy: object | undefined) =>
  [{ repo: 'acme/widgets', hasDeploy: true, prs: [], queue: null, deploy }] as unknown as DashboardState['repos'];

describe('DeployPanel', () => {
  it('renders each env with its short live sha + reachable dot and the awaiting counts', () => {
    render(<DeployPanel repos={repos({
      envs: [{ name: 'qa', liveSha: 'a1b2c3d4e5', reachable: true },
        { name: 'prod', liveSha: null, reachable: false }],
      awaitingQa: 0, awaitingProd: 3,
      firstEnv: 'qa', terminalEnv: 'prod',
    })} />);
    expect(screen.getByText('qa')).toBeInTheDocument();
    expect(screen.getByText(/a1b2c3/)).toBeInTheDocument();
    expect(screen.getByText('prod')).toBeInTheDocument();
    expect(screen.getByText(/3 awaiting prod/i)).toBeInTheDocument();
    expect(screen.getAllByTestId('spine-deploy-env')).toHaveLength(2);
  });

  it('renders real env names from firstEnv/terminalEnv instead of literal QA/prod', () => {
    render(<DeployPanel repos={repos({
      envs: [{ name: 'staging', liveSha: 'deadbeef', reachable: true },
        { name: 'production', liveSha: 'cafebabe', reachable: true }],
      awaitingQa: 2, awaitingProd: 5,
      firstEnv: 'staging', terminalEnv: 'production',
    })} />);
    expect(screen.getByText(/2 awaiting staging/i)).toBeInTheDocument();
    expect(screen.getByText(/5 awaiting production/i)).toBeInTheDocument();
    expect(screen.queryByText(/awaiting QA/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/awaiting prod(?!uction)/i)).not.toBeInTheDocument();
  });

  it('falls back to literal "QA"/"prod" when firstEnv/terminalEnv are null', () => {
    render(<DeployPanel repos={repos({
      envs: [{ name: 'qa', liveSha: null, reachable: false }],
      awaitingQa: 1, awaitingProd: 0,
      firstEnv: null, terminalEnv: null,
    })} />);
    expect(screen.getByText(/1 awaiting QA/i)).toBeInTheDocument();
  });

  it('shows an empty note when no repo has deploy data', () => {
    render(<DeployPanel repos={repos(undefined)} />);
    expect(screen.getByText(/no deploy/i)).toBeInTheDocument();
  });
});
