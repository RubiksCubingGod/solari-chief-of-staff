import { randomInt, randomUUID } from 'node:crypto';

import express, { type Express, type Request, type Response } from 'express';

import {
  buildInstanceControl,
  type ControlRequest,
  type FixtureHandle,
  type InstanceControl,
  mountInstanceRoutes,
  readRecord,
  startFixture,
  type StartFixtureOptions,
} from './harness.js';
import { buildModeControl, createModeState, type ModeControl, type ModeSeed } from './modes.js';
import { escapeHtml, type PageContent } from './pages.js';

export type MemberStatus = 'active' | 'retained' | 'cancelled';

/**
 * Every way the cancellation flow can refuse, named. action-playbooks branches
 * on these: `step-skipped` means the engine got ahead of itself, `wrong-code`
 * means it did not actually ask the user, and neither is a hint to retry.
 */
export type CancellationRefusal = 'unauthenticated' | 'step-skipped' | 'wrong-code';

export interface MemberInput {
  readonly id: string;
  readonly email: string;
  readonly password: string;
  readonly name: string;
}

export interface Member {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly status: MemberStatus;
}

/**
 * Everything a fakegym instance knows, as `GET /__test/state` reports it.
 *
 * Members are reported in their public shape: the confirmation code stays
 * behind `GET /__test/member/:id/code` and out of every other response, which
 * is the whole reason "the engine actually asked the user" is provable here.
 */
export interface FakegymState {
  readonly members: readonly Member[];
}

export interface FakegymSeed extends ModeSeed {
  readonly members?: readonly MemberInput[];
}

export interface FakegymControl extends InstanceControl<FakegymState, FakegymSeed>, ModeControl {
  seedMember(input: MemberInput): Promise<Member>;
  member(id: string): Promise<Member>;
  confirmationCode(id: string): Promise<string>;
}

interface StoredMember extends MemberInput {
  status: MemberStatus;
  readonly code: string;
}

interface Session {
  readonly memberId: string;
  /** How far this session has actually walked, held here rather than in the URL. */
  progress: number;
}

const SESSION_COOKIE = 'fakegym_session';

/**
 * The code the fixture "emails". It is generated, never seeded, so no test can
 * accidentally hard-code it, and it is prefixed so a leak assertion cannot pass
 * by coincidence against an unrelated six-digit string.
 */
function generateCode(): string {
  return `GYM-${randomInt(0, 1_000_000).toString().padStart(6, '0')}`;
}

function publicMember(member: StoredMember): Member {
  return { id: member.id, email: member.email, name: member.name, status: member.status };
}

function page(title: string, main: string[]): PageContent {
  return { title, main: main.join('\n') };
}

function stepPage(step: number, heading: string, prompt: string): PageContent {
  return page(heading, [
    `      <section class="gym-step" data-testid="cancel-step-${step}">`,
    `        <h1>${escapeHtml(heading)}</h1>`,
    `        <p>${escapeHtml(prompt)}</p>`,
    `        <form method="post" action="/cancel/step-${step}">`,
    '          <input type="hidden" name="choice" value="continue" />',
    `          <button type="submit" data-testid="continue-cancellation">Continue cancelling</button>`,
    '        </form>',
    '      </section>',
  ]);
}

export function startFakegymFixture(
  options: StartFixtureOptions = {},
): Promise<FixtureHandle<FakegymControl>> {
  const members = new Map<string, StoredMember>();
  const sessions = new Map<string, Session>();
  let baseline: StoredMember[] = [];
  // The hostile modes every fixture shares: the blocked shells, and a redesign
  // that here hands retention to a partner host. Members keep their own state.
  const modes = createModeState();

  const parseMember = (body: unknown): StoredMember | string => {
    const { id, email, password, name } = readRecord(body);
    if (
      typeof id !== 'string' ||
      typeof email !== 'string' ||
      typeof password !== 'string' ||
      typeof name !== 'string' ||
      [id, email, password, name].some((field) => field.trim() === '')
    ) {
      return 'id, email, password and name are required';
    }
    return { id, email, password, name, status: 'active', code: generateCode() };
  };

  /** The seed's members, if it names any: every one valid, or the first complaint. */
  const parseMembers = (raw: unknown): StoredMember[] | string | undefined => {
    if (raw === undefined) {
      return undefined;
    }
    if (!Array.isArray(raw)) {
      return 'members must be an array';
    }
    const parsed: StoredMember[] = [];
    for (const entry of raw) {
      const member = parseMember(entry);
      if (typeof member === 'string') {
        return member;
      }
      parsed.push(member);
    }
    return parsed;
  };

  /** This server by the name the allowlist does not carry, for the redesign's partner redirect. */
  const partnerOrigin = (request: Request): string => {
    const port = request.get('host')?.split(':')[1];
    return `http://localhost${port === undefined ? '' : `:${port}`}`;
  };

  const readSession = (request: Request): Session | undefined => {
    const header = request.get('cookie') ?? '';
    for (const part of header.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === SESSION_COOKIE) {
        return sessions.get(rest.join('='));
      }
    }
    return undefined;
  };

  const refuse = (response: Response, status: number, code: CancellationRefusal): void => {
    const messages: Record<CancellationRefusal, string> = {
      unauthenticated: 'sign in first',
      'step-skipped': 'complete the previous step first',
      'wrong-code': 'that confirmation code is not correct',
    };
    response.status(status).json({ code, message: messages[code] });
  };

  /** Resolves the acting member, or answers the request itself and returns undefined. */
  const acting = (
    request: Request,
    response: Response,
    onMissing: 'redirect' | 'refuse',
  ): StoredMember | undefined => {
    const session = readSession(request);
    const member = session === undefined ? undefined : members.get(session.memberId);
    if (session === undefined || member === undefined) {
      if (onMissing === 'redirect') {
        response.redirect(302, '/login');
      } else {
        refuse(response, 401, 'unauthenticated');
      }
      return undefined;
    }
    return member;
  };

  const mount = (app: Express): void => {
    app.use(express.urlencoded({ extended: false }));
    modes.mount(app);

    mountInstanceRoutes<FakegymState>(app, {
      state: () => ({ members: [...members.values()].map(publicMember) }),
      seed: (body) => {
        const record = readRecord(body);
        const parsed = parseMembers(record.members);
        if (typeof parsed === 'string') {
          return parsed;
        }
        const refusal = modes.seed(record);
        if (refusal !== undefined) {
          return refusal;
        }
        if (parsed !== undefined) {
          members.clear();
          for (const member of parsed) {
            members.set(member.id, member);
          }
          // A fresh starting state means nobody is signed in; leaving sessions
          // behind would let a seeded instance answer as a member it no longer has.
          sessions.clear();
        }
        baseline = [...members.values()].map((member) => ({ ...member }));
        return undefined;
      },
      reset: () => {
        members.clear();
        // Restored with their original codes, so a test may read a code, walk
        // the flow, reset, and walk it again with the same code.
        for (const member of baseline) {
          members.set(member.id, { ...member });
        }
        sessions.clear();
        modes.reset();
      },
    });

    app.get('/', (request, response) => {
      modes.serve(request, response, () =>
        page('Fakegym', [
          '      <h1>Fakegym</h1>',
          '      <a href="/login" data-testid="go-to-login">Sign in</a>',
        ]),
      );
    });

    app.get('/login', (request, response) => {
      modes.serve(request, response, () =>
        page('Sign in', [
          '      <h1>Sign in</h1>',
          '      <form method="post" action="/login">',
          '        <label>Email <input type="email" name="email" data-testid="email" /></label>',
          '        <label>Password <input type="password" name="password" data-testid="password" /></label>',
          '        <button type="submit" data-testid="sign-in">Sign in</button>',
          '      </form>',
        ]),
      );
    });

    app.post('/login', (request, response) => {
      const { email, password } = readRecord(request.body);
      const member = [...members.values()].find(
        (candidate) => candidate.email === email && candidate.password === password,
      );
      if (member === undefined) {
        response.status(401).json({ code: 'bad-credentials', message: 'no such member' });
        return;
      }
      const id = randomUUID();
      sessions.set(id, { memberId: member.id, progress: 0 });
      response.setHeader('set-cookie', `${SESSION_COOKIE}=${id}; Path=/; HttpOnly`);
      response.redirect(302, '/member');
    });

    app.get('/member', (request, response) => {
      const member = acting(request, response, 'redirect');
      if (member === undefined) {
        return;
      }
      modes.serve(request, response, () =>
        page(`${member.name}'s membership`, [
          '      <section class="gym-member">',
          `        <h1>${escapeHtml(member.name)}</h1>`,
          `        <p data-testid="member-status" aria-label="Membership status">${member.status}</p>`,
          '        <a href="/cancel/step-1" data-testid="start-cancellation">Cancel membership</a>',
          '      </section>',
        ]),
      );
    });

    app.get('/cancel/step-1', (request, response) => {
      if (acting(request, response, 'redirect') === undefined) {
        return;
      }
      modes.serve(request, response, () =>
        page('Before you go', [
          '      <section class="gym-step" data-testid="cancel-step-1">',
          '        <h1>Before you go</h1>',
          '        <p>Stay with us and get two months at half price.</p>',
          '        <form method="post" action="/cancel/step-1">',
          '          <button type="submit" name="choice" value="keep" data-testid="keep-membership">Keep my membership</button>',
          '          <button type="submit" name="choice" value="continue" data-testid="continue-cancellation">Continue cancelling</button>',
          '        </form>',
          '      </section>',
        ]),
      );
    });

    app.post('/cancel/step-1', (request, response) => {
      const member = acting(request, response, 'refuse');
      const session = readSession(request);
      if (member === undefined || session === undefined) {
        return;
      }
      if (modes.current() === 'redesign') {
        // The redesigned site hands retention to a partner on another host
        // before it has advanced anything: an engine that follows leaves its
        // allowlist, and one that refuses to leaves the membership as it was.
        response.redirect(302, `${partnerOrigin(request)}/partner/retention`);
        return;
      }
      if (readRecord(request.body).choice === 'keep') {
        // A real site will win here sometimes. The engine has to be able to
        // lose this way, so `retained` is a first-class terminal state.
        member.status = 'retained';
        session.progress = 0;
        response.json({ status: member.status });
        return;
      }
      session.progress = 1;
      response.json({ status: member.status, next: '/cancel/step-2' });
    });

    for (const step of [2, 3] as const) {
      app.get(`/cancel/step-${step}`, (request, response) => {
        const member = acting(request, response, 'redirect');
        const session = readSession(request);
        if (member === undefined || session === undefined) {
          return;
        }
        if (session.progress < step - 1) {
          refuse(response, 409, 'step-skipped');
          return;
        }
        modes.serve(request, response, () =>
          step === 2
            ? stepPage(2, 'Are you sure?', 'Your access ends at the close of the billing period.')
            : stepPage(3, 'Really sure?', 'This cannot be undone from the app.'),
        );
      });

      app.post(`/cancel/step-${step}`, (request, response) => {
        const member = acting(request, response, 'refuse');
        const session = readSession(request);
        if (member === undefined || session === undefined) {
          return;
        }
        if (session.progress < step - 1) {
          refuse(response, 409, 'step-skipped');
          return;
        }
        session.progress = step;
        response.json({
          status: member.status,
          next: step === 2 ? '/cancel/step-3' : '/cancel/confirm',
        });
      });
    }

    app.get('/cancel/confirm', (request, response) => {
      const member = acting(request, response, 'redirect');
      const session = readSession(request);
      if (member === undefined || session === undefined) {
        return;
      }
      if (session.progress < 3) {
        refuse(response, 409, 'step-skipped');
        return;
      }
      modes.serve(request, response, () =>
        page('Enter your confirmation code', [
          '      <section class="gym-step" data-testid="cancel-confirm">',
          '        <h1>Enter your confirmation code</h1>',
          '        <p>We emailed a six-digit code to your address on file.</p>',
          '        <form method="post" action="/cancel/confirm">',
          '          <label>Confirmation code <input type="text" name="code" data-testid="confirmation-code" /></label>',
          '          <button type="submit" data-testid="confirm-cancellation">Cancel my membership</button>',
          '        </form>',
          '      </section>',
        ]),
      );
    });

    app.post('/cancel/confirm', (request, response) => {
      const member = acting(request, response, 'refuse');
      const session = readSession(request);
      if (member === undefined || session === undefined) {
        return;
      }
      if (member.status === 'cancelled') {
        response.json({ status: member.status });
        return;
      }
      if (session.progress < 3) {
        refuse(response, 409, 'step-skipped');
        return;
      }
      if (readRecord(request.body).code !== member.code) {
        refuse(response, 422, 'wrong-code');
        return;
      }
      member.status = 'cancelled';
      response.json({ status: member.status });
    });

    // The "partner" the redesign hands retention to: this same server by a
    // name the task's allowlist does not carry, which is what makes following
    // it a violation rather than a page.
    app.get('/partner/retention', (request, response) => {
      modes.serve(request, response, () =>
        page('Partner retention', [
          '      <section class="gym-partner" data-testid="partner-retention">',
          '        <h1>Our partner would like a word</h1>',
          '      </section>',
        ]),
      );
    });

    app.post('/__test/member', (request, response) => {
      const member = parseMember(request.body);
      if (typeof member === 'string') {
        response.status(400).json({ error: member });
        return;
      }
      members.set(member.id, member);
      response.json(publicMember(member));
    });

    app.get('/__test/member/:id', (request, response) => {
      const member = members.get(request.params.id);
      if (member === undefined) {
        response.status(404).json({ error: 'no such member' });
        return;
      }
      response.json(publicMember(member));
    });

    // The only place the code is readable. action-playbooks' scripted UserIO
    // answers from here, which is what makes "the engine actually asked" a
    // provable claim rather than a hopeful one.
    app.get('/__test/member/:id/code', (request, response) => {
      const member = members.get(request.params.id);
      if (member === undefined) {
        response.status(404).json({ error: 'no such member' });
        return;
      }
      response.json({ code: member.code });
    });
  };

  const buildControl = (request: ControlRequest): FakegymControl => ({
    ...buildInstanceControl<FakegymState, FakegymSeed>(request),
    ...buildModeControl(request),
    seedMember: (input) => request<Member>('POST', '/__test/member', input),
    member: (id) => request<Member>('GET', `/__test/member/${id}`),
    confirmationCode: async (id) =>
      (await request<{ code: string }>('GET', `/__test/member/${id}/code`)).code,
  });

  return startFixture('fakegym', mount, buildControl, options);
}
