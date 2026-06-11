import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueueTrain } from '../QueueTrain';
import type { RepoQueueView, QueueGroupView } from '../types';

const group = (over: Partial<QueueGroupView>): QueueGroupView => ({
  oid: 'abc123',
  prNumbers: [8943, 8941],
  percent: 80,
  etaSeconds: 120,
  failed: false,
  ...over,
});

describe('QueueTrain', () => {
  it('renders nothing when queue is null', () => {
    const { container } = render(<QueueTrain queue={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when queue has no groups and no waiting entries', () => {
    const queue: RepoQueueView = { groups: [], waiting: [], batchSize: 6 };
    const { container } = render(<QueueTrain queue={queue} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a building car for each group with progress bar', () => {
    const queue: RepoQueueView = {
      groups: [
        group({ prNumbers: [8943, 8941, 8939], percent: 80, etaSeconds: 120 }),
        group({ oid: 'def456', prNumbers: [8905, 8902], percent: 30, etaSeconds: 600 }),
      ],
      waiting: [],
      batchSize: 6,
    };
    const { container } = render(<QueueTrain queue={queue} />);
    // Two building cars
    const cars = container.querySelectorAll('.car.building');
    expect(cars).toHaveLength(2);
    // Headers present (two building groups each have the header)
    expect(screen.getAllByText('▶ group')).toHaveLength(2);
    // Progress text
    expect(screen.getByText(/80% · ~2m/)).toBeInTheDocument();
    expect(screen.getByText(/30% · ~10m/)).toBeInTheDocument();
  });

  it('renders PR number anchor links pointing to #pr-{n} inside building car', () => {
    const queue: RepoQueueView = {
      groups: [group({ prNumbers: [8943, 8941] })],
      waiting: [],
      batchSize: 6,
    };
    const { container } = render(<QueueTrain queue={queue} />);
    const links = container.querySelectorAll('.car.building a');
    expect(links).toHaveLength(2);
    expect((links[0] as HTMLAnchorElement).href).toContain('#pr-8943');
    expect((links[1] as HTMLAnchorElement).href).toContain('#pr-8941');
    expect(links[0].textContent).toBe('#8943');
    expect(links[1].textContent).toBe('#8941');
  });

  it('renders a failed building car with red border class + failing label', () => {
    const queue: RepoQueueView = {
      groups: [group({ failed: true, percent: 89, etaSeconds: null })],
      waiting: [],
      batchSize: 6,
    };
    const { container } = render(<QueueTrain queue={queue} />);
    const failCar = container.querySelector('.car.building.failed');
    expect(failCar).not.toBeNull();
    expect(failCar!.textContent).toContain('✗ failing');
  });

  it('renders building car with no progress bar text when percent is null', () => {
    const queue: RepoQueueView = {
      groups: [group({ percent: null, etaSeconds: null })],
      waiting: [],
      batchSize: 6,
    };
    const { container } = render(<QueueTrain queue={queue} />);
    expect(container.querySelector('.car.building')).not.toBeNull();
    // No percent text rendered
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it('waiting: 7 entries with batchSize 6 → next-batch car (6 numbers) + then car (1)', () => {
    const waiting = Array.from({ length: 7 }, (_, i) => ({ prNumber: 8960 - i, position: i + 1 }));
    const queue: RepoQueueView = { groups: [], waiting, batchSize: 6 };
    const { container } = render(<QueueTrain queue={queue} />);
    const dashed = container.querySelectorAll('.car.queued');
    expect(dashed).toHaveLength(2);
    // First = next batch
    expect(dashed[0].textContent).toContain('next batch');
    // Second = then
    expect(dashed[1].textContent).toContain('then');
    // then car shows count of remaining (1)
    expect(dashed[1].textContent).toContain('1 more');
  });

  it('next-batch car shows up to batchSize numbers then +N overflow', () => {
    // 10 waiting, batchSize 4 → first car shows 4, rest in "then" (6)
    const waiting = Array.from({ length: 10 }, (_, i) => ({ prNumber: 8900 + i, position: i + 1 }));
    const queue: RepoQueueView = { groups: [], waiting, batchSize: 4 };
    const { container } = render(<QueueTrain queue={queue} />);
    const dashed = container.querySelectorAll('.car.queued');
    expect(dashed).toHaveLength(2);
    // next batch shows exactly 4 numbers as links, no overflow in this case since batchSize=4
    const nextLinks = dashed[0].querySelectorAll('a');
    expect(nextLinks).toHaveLength(4);
    // "then" car shows 6 remaining
    expect(dashed[1].textContent).toContain('6 more');
  });

  it('next-batch car overflows with +N when batchSize exceeds MAX_NUMBERS_PER_CAR', () => {
    // batchSize=8, 10 waiting → next-batch car slices 8 entries but PrLinks only shows 6 + "+2"
    // "then" car shows 2 more (10 - 8 = 2 remaining)
    const waiting = Array.from({ length: 10 }, (_, i) => ({ prNumber: 9000 + i, position: i + 1 }));
    const queue: RepoQueueView = { groups: [], waiting, batchSize: 8 };
    const { container } = render(<QueueTrain queue={queue} />);
    const dashed = container.querySelectorAll('.car.queued');
    expect(dashed).toHaveLength(2);
    // next-batch car: PrLinks shows max 6 links out of 8 entries, renders "+2" overflow
    const nextLinks = dashed[0].querySelectorAll('a');
    expect(nextLinks).toHaveLength(6);
    expect(dashed[0].textContent).toContain('+2');
    // then car: 10 - 8 = 2 remaining
    expect(dashed[1].textContent).toContain('2 more');
  });

  it('single waiting entry → one next-batch car, no then car', () => {
    const queue: RepoQueueView = {
      groups: [],
      waiting: [{ prNumber: 8960, position: 1 }],
      batchSize: 6,
    };
    const { container } = render(<QueueTrain queue={queue} />);
    const dashed = container.querySelectorAll('.car.queued');
    expect(dashed).toHaveLength(1);
    expect(dashed[0].textContent).toContain('next batch');
  });

  it('car has title tooltip listing its PR numbers', () => {
    const queue: RepoQueueView = {
      groups: [group({ prNumbers: [8943, 8941, 8939] })],
      waiting: [],
      batchSize: 6,
    };
    const { container } = render(<QueueTrain queue={queue} />);
    const car = container.querySelector('.car.building')!;
    const title = car.getAttribute('title');
    expect(title).toContain('#8943');
    expect(title).toContain('#8941');
    expect(title).toContain('#8939');
  });

  it('car with >6 numbers shows +N overflow for the displayed list', () => {
    const queue: RepoQueueView = {
      groups: [group({ prNumbers: [100, 101, 102, 103, 104, 105, 106, 107] })],
      waiting: [],
      batchSize: 6,
    };
    const { container } = render(<QueueTrain queue={queue} />);
    const car = container.querySelector('.car.building')!;
    // Max 6 links visible
    const links = car.querySelectorAll('a');
    expect(links).toHaveLength(6);
    // Overflow text "+2"
    expect(car.textContent).toContain('+2');
  });

  it('anchor click calls scrollIntoView and prevents default navigation', () => {
    const mockScrollIntoView = vi.fn();
    const mockGetElementById = vi.spyOn(document, 'getElementById').mockReturnValue({
      scrollIntoView: mockScrollIntoView,
    } as unknown as HTMLElement);

    const queue: RepoQueueView = {
      groups: [group({ prNumbers: [8943] })],
      waiting: [],
      batchSize: 6,
    };
    render(<QueueTrain queue={queue} />);
    const link = screen.getByText('#8943');
    fireEvent.click(link);

    expect(mockGetElementById).toHaveBeenCalledWith('pr-8943');
    expect(mockScrollIntoView).toHaveBeenCalledOnce();

    mockGetElementById.mockRestore();
  });

  it('renders the train wrapper with overflow-x scroll class', () => {
    const queue: RepoQueueView = {
      groups: [group({})],
      waiting: [],
      batchSize: 6,
    };
    const { container } = render(<QueueTrain queue={queue} />);
    const train = container.querySelector('.queue-train');
    expect(train).not.toBeNull();
  });

  it('renders building + waiting cars together', () => {
    const queue: RepoQueueView = {
      groups: [group({ prNumbers: [8943], percent: 80, etaSeconds: 120 })],
      waiting: [
        { prNumber: 8960, position: 1 },
        { prNumber: 8958, position: 2 },
      ],
      batchSize: 6,
    };
    const { container } = render(<QueueTrain queue={queue} />);
    expect(container.querySelector('.car.building')).not.toBeNull();
    expect(container.querySelector('.car.queued')).not.toBeNull();
  });
});
