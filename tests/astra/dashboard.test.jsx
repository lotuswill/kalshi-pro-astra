import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { test, expect, vi } from 'vitest';
import { ComboDashboard } from '../../src/ComboDashboard.jsx';

test('combo workspace starts focused, preserves research across account views, and opens other tools only on demand', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const fetcher = vi.fn(() => { throw new Error('No network request expected'); });
  vi.stubGlobal('fetch', fetcher);
  const connection = vi.fn(() => <div>Connection panel</div>);
  const positions = vi.fn(() => <div>Positions panel</div>);
  const otherTools = vi.fn(() => <div>Other tools panel</div>);
  const host = document.createElement('div'); document.body.append(host);
  const app = createRoot(host);
  try {
    await act(async () => app.render(<ComboDashboard profile="focus-test" apiBase="/kalshi/trade-api/v2" authFetch={vi.fn()} connected={false} onLock={vi.fn()} connection={connection} positions={positions} otherTools={otherTools} />));
    const shadow = host.querySelector('[aria-label="Astra combo scanner and hedge optimizer"]').shadowRoot;
    expect(otherTools).not.toHaveBeenCalled(); expect(connection).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
    expect(host.querySelector('[aria-current="page"]').textContent).toBe('Combos');
    expect(shadow.querySelector('.sidebar')).toBeNull();
    expect(shadow.querySelector('[data-disclosure="filters"]').open).toBe(false);
    await act(async () => shadow.querySelector('[data-action="sample"]').click());
    expect(shadow.querySelectorAll('tbody tr')).toHaveLength(5);
    const filters = shadow.querySelector('[data-disclosure="filters"]'); filters.open = true;
    const sort = shadow.querySelector('[data-filter="sort"]'); sort.value = 'openInterest';
    await act(async () => sort.dispatchEvent(new Event('change', { bubbles: true })));
    expect(shadow.querySelector('[data-disclosure="filters"]').open).toBe(true);
    const click = async label => act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === label).click());
    await click('Connection');
    expect(host.querySelector('[aria-label="Combo workspace"]').hidden).toBe(true);
    expect(connection).toHaveBeenCalled(); expect(otherTools).not.toHaveBeenCalled();
    await click('Combos');
    expect(shadow.querySelectorAll('tbody tr')).toHaveLength(5);
    expect(shadow.querySelector('[data-filter="sort"]').value).toBe('openInterest');
    expect(shadow.querySelector('[data-disclosure="filters"]').open).toBe(true);
    await act(async () => shadow.querySelector('button[data-market="kalshi:DEMO-ABCD"]').click());
    await act(async () => shadow.querySelector('[data-page="paper"]').click());
    // Automatic paper needs Web Locks, but enabling itself makes no network call.
    await act(async () => shadow.querySelector('[data-action="auto"]').click());
    expect(shadow.textContent).toContain('AUTO PAPER ACTIVE');
    await click('Live positions'); await click('Combos');
    expect(shadow.textContent).not.toContain('AUTO PAPER ACTIVE');
    expect(shadow.querySelector('[data-action="auto"]').textContent).toBe('Enable automatic paper');
    await click('Other tools'); expect(otherTools).toHaveBeenCalledTimes(1);
    await click('Back to combos'); expect(shadow.querySelector('[data-page="paper"]').getAttribute('aria-current')).toBe('page');
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    await act(async () => app.unmount()); host.remove(); localStorage.clear(); vi.unstubAllGlobals();
  }
});
