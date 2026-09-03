import { describe, expect, it } from 'vitest';

import { cancellationSiteOf } from './action.js';

/**
 * The one key the auto-cancel arm reads off an entry's free-form `action`.
 * Everything that is not a site named as a word is "no site", so the arm
 * marks the entry rather than enqueuing a task that names nowhere.
 */

describe('cancellationSiteOf', () => {
  it('reads the site an entry names, trimmed', () => {
    expect(cancellationSiteOf({ site: 'fakegym' })).toBe('fakegym');
    expect(cancellationSiteOf({ site: '  fakegym ' })).toBe('fakegym');
    expect(cancellationSiteOf({ site: 'fakegym', note: 'the annual plan' })).toBe('fakegym');
  });

  it('is nothing when the entry names none', () => {
    expect(cancellationSiteOf(null)).toBeUndefined();
    expect(cancellationSiteOf(undefined)).toBeUndefined();
    expect(cancellationSiteOf({})).toBeUndefined();
    expect(cancellationSiteOf({ site: '' })).toBeUndefined();
    expect(cancellationSiteOf({ site: '   ' })).toBeUndefined();
    expect(cancellationSiteOf({ site: null })).toBeUndefined();
    expect(cancellationSiteOf({ site: 42 })).toBeUndefined();
    expect(cancellationSiteOf({ site: { host: 'fakegym' } })).toBeUndefined();
  });

  it('is nothing when the action is not an object at all', () => {
    expect(cancellationSiteOf('fakegym')).toBeUndefined();
    expect(cancellationSiteOf(['fakegym'])).toBeUndefined();
    expect(cancellationSiteOf(7)).toBeUndefined();
  });
});
