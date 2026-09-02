import { describe, expect, it } from 'vitest';

import { definePlaybook, type PlaybookDefinition, type PlaybookStep } from './playbook.js';
import { createPlaybookRegistry } from './registry.js';

const step = (name: string): PlaybookStep => ({ name, run: () => Promise.resolve({ kind: 'done' }) });

const GYM: PlaybookDefinition = {
  site: 'fakegym',
  action: 'cancel',
  origin: 'http://127.0.0.1:4303',
  steps: [step('login')],
};

describe('definePlaybook', () => {
  it('fills in the id, the connection domain, and an allowlist of the origin plus whatever else is allowed', () => {
    const playbook = definePlaybook({
      ...GYM,
      origin: 'https://gym.example.test:8443/members/home?tab=1',
      alsoAllow: ['cdn.example.test'],
      steps: [step('login'), step('cancel')],
    });
    expect(playbook).toMatchObject({
      id: 'fakegym.cancel',
      site: 'fakegym',
      action: 'cancel',
      origin: 'https://gym.example.test:8443',
      siteDomain: 'gym.example.test:8443',
      allowlist: ['gym.example.test', 'cdn.example.test'],
    });
    expect(playbook.steps.map((entry) => entry.name)).toEqual(['login', 'cancel']);
  });

  it('keeps an id it is given', () => {
    expect(definePlaybook({ ...GYM, id: 'fakegym-cancel-v2' }).id).toBe('fakegym-cancel-v2');
  });

  it('copies the steps, so a definition edited later does not change a playbook already built', () => {
    const steps = [step('login')];
    const playbook = definePlaybook({ ...GYM, steps });
    steps.push(step('cancel'));
    expect(playbook.steps).toHaveLength(1);
  });

  const refused: [string, Partial<PlaybookDefinition>, RegExp][] = [
    ['an origin that is not a URL', { origin: 'gym dot example' }, /origin gym dot example is not a URL/],
    ['a blank site', { site: '  ' }, /needs a site/],
    ['no steps', { steps: [] }, /fakegym\.cancel has no steps/],
    ['a step without a name', { steps: [step('login'), step(' ')] }, /unique and non-empty/],
    ['two steps with one name', { steps: [step('login'), step('login')] }, /unique and non-empty/],
  ];

  it.each(refused)('refuses %s', (_named, overrides, message) => {
    expect(() => definePlaybook({ ...GYM, ...overrides })).toThrow(message);
  });
});

describe('createPlaybookRegistry', () => {
  const gym = definePlaybook(GYM);
  const booking = definePlaybook({ ...GYM, action: 'book_slot' });
  const dmv = definePlaybook({ ...GYM, site: 'fakedmv', action: 'book_slot', origin: 'http://127.0.0.1:4304' });

  it('finds a playbook by the site a task names and the kind of task it is', () => {
    const registry = createPlaybookRegistry([gym, booking, dmv]);
    expect(registry.lookup('fakegym', 'cancel')).toBe(gym);
    expect(registry.lookup('fakegym', 'book_slot')).toBe(booking);
    expect(registry.lookup('fakedmv', 'book_slot')).toBe(dmv);
    expect(registry.playbooks).toEqual([gym, booking, dmv]);
  });

  it('answers nothing for a pair nobody claims', () => {
    const registry = createPlaybookRegistry([gym]);
    expect(registry.lookup('fakedmv', 'cancel')).toBeUndefined();
    expect(registry.lookup('fakegym', 'custom')).toBeUndefined();
    expect(createPlaybookRegistry([]).lookup('fakegym', 'cancel')).toBeUndefined();
  });

  it('refuses to be built when two playbooks claim one pair, naming both', () => {
    const rival = definePlaybook({ ...GYM, id: 'fakegym-cancel-v2' });
    expect(() => createPlaybookRegistry([gym, dmv, rival])).toThrow(
      'playbooks fakegym.cancel and fakegym-cancel-v2 both claim cancel on fakegym',
    );
  });
});
