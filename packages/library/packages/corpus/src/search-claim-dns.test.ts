import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:https', () => ({ request: mocks.request }));
import { fetchEvidence } from './search-fetch.js';
it('starts no HTTP after an aborted deferred public DNS lookup resolves', async () => {
  let finish!: (value: { address: string; family: number }[]) => void;
  mocks.lookup.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const controller = new AbortController();
  const operation = fetchEvidence('https://example.org/primary', controller.signal);
  controller.abort();
  finish([{ address: '93.184.216.34', family: 4 }]);
  await expect(operation).rejects.toThrow();
  expect(mocks.request).not.toHaveBeenCalled();
});
