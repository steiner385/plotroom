import { render, screen } from '@testing-library/react';
import { RouterProvider } from '../embed/RouterContext';
import { ApiBaseProvider } from '../embed/ApiBaseContext';
import { SectionContent } from '../SectionContent';
import { makeWorkspaceApi } from '../shell/workspaceApi';

const api = makeWorkspaceApi();
const wrap = (ui: React.ReactNode) =>
  <ApiBaseProvider><RouterProvider mode="hash">{ui}</RouterProvider></ApiBaseProvider>;

it('renders the live-feed guard when state is null', () => {
  render(wrap(<SectionContent active="health" state={null} connected={false} api={api} focused={null} onFocusRepo={() => {}} />));
  expect(screen.getByRole('status')).toHaveTextContent(/Connecting to the live feed/i);
});

it('does not emit a main landmark', () => {
  const { container } = render(wrap(<SectionContent active="health" state={null} connected={false} api={api} focused={null} onFocusRepo={() => {}} />));
  expect(container.querySelector('[role="main"]')).toBeNull();
  expect(container.querySelector('main')).toBeNull();
});
