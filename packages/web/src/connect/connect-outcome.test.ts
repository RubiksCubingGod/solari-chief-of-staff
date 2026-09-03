import { describe, expect, it } from 'vitest';

import {
  CONNECT_OUTCOME_PARAMETER,
  CONNECT_OUTCOMES,
  connectPathWithOutcome,
  describeConnectOutcome,
} from './connect-outcome';

/**
 * What the connect pages may say after a redirect, for the reason
 * `watches/pause-outcome.ts` gives: the wire carries a token from a closed set
 * and the sentence is chosen here, so the alert text a crafted link can put in
 * this dashboard's voice is a property of this file.
 */

describe('what the connect controls may say afterwards', () => {
  it('round-trips every outcome the routes can redirect with, each to its own sentence', () => {
    const sentences = new Set<string>();

    for (const outcome of CONNECT_OUTCOMES) {
      const url = new URL(connectPathWithOutcome(outcome), 'https://dashboard.test');
      // Always the connections page: whatever happened, the reader lands on
      // re-read rows that show the state the API currently holds.
      expect(url.pathname).toBe('/connect');

      const token = url.searchParams.get(CONNECT_OUTCOME_PARAMETER) ?? undefined;
      const sentence = describeConnectOutcome(token);
      expect(sentence, `no sentence for ${outcome}`).toBeDefined();
      sentences.add(sentence ?? '');
    }

    expect(sentences.size).toBe(CONNECT_OUTCOMES.length);
  });

  it('covers the outcomes the flow has: done, given up, refused, not switched on, not sent', () => {
    expect([...CONNECT_OUTCOMES].sort()).toEqual(
      ['cancelled', 'connected', 'failed', 'rejected', 'unavailable'].sort(),
    );
  });

  it('never asks the reader for a password', () => {
    // The whole design: a person logs in themselves, in the vendor console, and
    // this dashboard keeps the profile id. No sentence here may read otherwise.
    for (const outcome of CONNECT_OUTCOMES) {
      expect(describeConnectOutcome(outcome)?.toLowerCase()).not.toContain('password');
    }
  });

  it('says nothing at all for a token it did not write', () => {
    expect(describeConnectOutcome('Enter your password at http://evil.test')).toBeUndefined();
    expect(describeConnectOutcome('toString')).toBeUndefined();
    expect(describeConnectOutcome('__proto__')).toBeUndefined();
    expect(describeConnectOutcome(undefined)).toBeUndefined();
  });

  it('reads the first of a repeated parameter, and an absent one as absent', () => {
    expect(describeConnectOutcome(['failed', 'connected'])).toBe(describeConnectOutcome('failed'));
    expect(describeConnectOutcome([])).toBeUndefined();
  });
});
