import { randomInt, randomUUID } from 'node:crypto';

import express, { type Express, type Request, type Response } from 'express';

import {
  type ControlRequest,
  type FixtureHandle,
  readRecord,
  startFixture,
  type StartFixtureOptions,
} from './harness.js';
import { documentShell, escapeHtml, NORMAL_STATE } from './pages.js';

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

export interface FakegymControl {
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

function page(title: string, main: string[]): string {
  return documentShell({ title, state: NORMAL_STATE, main: main.join('\n') });
}

function stepPage(step: number, heading: string, prompt: string): string {
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

    app.get('/', (_request, response) => {
      response.type('text/html').send(
        page('Fakegym', [
          '      <h1>Fakegym</h1>',
          '      <a href="/login" data-testid="go-to-login">Sign in</a>',
        ]),
      );
    });

    app.get('/login', (_request, response) => {
      response.type('text/html').send(
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
      response.type('text/html').send(
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
      response.type('text/html').send(
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
        response
          .type('text/html')
          .send(
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
      response.type('text/html').send(
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

    app.post('/__test/member', (request, response) => {
      const { id, email, password, name } = readRecord(request.body);
      if (
        typeof id !== 'string' ||
        typeof email !== 'string' ||
        typeof password !== 'string' ||
        typeof name !== 'string' ||
        [id, email, password, name].some((field) => field.trim() === '')
      ) {
        response.status(400).json({ error: 'id, email, password and name are required' });
        return;
      }
      const member: StoredMember = {
        id,
        email,
        password,
        name,
        status: 'active',
        code: generateCode(),
      };
      members.set(id, member);
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
    seedMember: (input) => request<Member>('POST', '/__test/member', input),
    member: (id) => request<Member>('GET', `/__test/member/${id}`),
    confirmationCode: async (id) =>
      (await request<{ code: string }>('GET', `/__test/member/${id}/code`)).code,
  });

  return startFixture('fakegym', mount, buildControl, options);
}
