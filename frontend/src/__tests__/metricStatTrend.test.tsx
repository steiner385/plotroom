import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MetricStat } from '../metricsPanels';
import { trendOf } from '../metricsModel';
import { DEFS } from '../definitions';

describe('MetricStat trend', () => {
  it('renders a TrendArrow when a significant trend is passed', () => {
    const trend = trendOf({ value: 150, prev: 100 }, false); // +50%, higher-is-better → good
    const { getByLabelText } = render(<MetricStat label="merges" value="150" trend={trend} def={DEFS.trendCounts} />);
    expect(getByLabelText('+50% vs prev window').textContent).toBe('▲');
  });
  it('renders no arrow for an insignificant change', () => {
    const trend = trendOf({ value: 102, prev: 100 }, false); // +2% < 5% floor
    const { container } = render(<MetricStat label="merges" value="102" trend={trend} def={DEFS.trendCounts} />);
    expect(container.querySelector('.trend-arrow')).toBeNull();
  });
  it('lowerIsBetter flips polarity: a rising p50 is bad', () => {
    const trend = trendOf({ value: 200, prev: 100 }, true);
    expect(trend.polarity).toBe('bad');
  });
});
