import { describe, expect, it } from 'vitest';

import { ApiError, ApiUnreachableError, type TaskDetail, type TaskEvent } from '../api-client';
import { stubClient } from '../testing/stub-client';
import { describeEvent, loadTaskDetail, toView } from './detail-view-model';

const TASK_ID = '3b6f0d4e-9f0a-4b8c-8f4e-1c2d3e4f5a6b';
const QUESTION = 'The gym asks for a reason. What should I say?';

function event(seq: number, type: TaskEvent['type'], payload: unknown): TaskEvent {
  return { seq, ts: `2026-08-30T10:00:${String(seq).padStart(2, '0')}.000Z`, type, payload };
}

const ASKED = event(3, 'ask_user', {
  questionId: 'q-1',
  question: QUESTION,
  askedAt: '2026-08-30T10:00:03.000Z',
  expiresAt: '2026-08-30T22:00:03.000Z',
});
const REPLIED = event(4, 'user_reply', {
  questionId: 'q-1',
  reply: 'Moving away',
  answeredAt: '2026-08-30T10:04:00.000Z',
});

function detail(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: TASK_ID,
    userId: 'user-1',
    kind: 'cancel',
    input: { note: 'gym' },
    status: 'succeeded',
    mode: 'playbook',
    playbookId: null,
    solariSessionId: null,
    recordingUrl: null,
    result: null,
    llmUsage: null,
    createdAt: '2026-08-30T10:00:00.000Z',
    finishedAt: '2026-08-30T10:05:00.000Z',
    events: [],
    recording: { available: false },
    ...overrides,
  };
}

describe('describeEvent', () => {
  it('turns each declared event shape into a headline a person can read', () => {
    expect(
      describeEvent(event(1, 'transition', { from: 'queued', to: 'running', cause: 'started', detail: null })),
    ).toMatchObject({ headline: 'queued → running (started)', detail: undefined });
    expect(describeEvent(event(2, 'step', { name: 'open_site', outcome: 'ok' }))).toMatchObject({
      headline: 'open_site: ok',
      detail: undefined,
    });
    expect(describeEvent(event(2, 'step', { name: 'open_site' })).headline).toBe('open_site');
    expect(describeEvent(ASKED)).toMatchObject({
      headline: `Asked: ${QUESTION}`,
      detail: 'answer wanted by 2026-08-30T22:00:03.000Z',
    });
    expect(describeEvent(REPLIED)).toMatchObject({ headline: 'Replied: Moving away' });
    expect(
      describeEvent(
        event(5, 'rejected', { attempted: 'answered', status: 'running', reason: 'not_waiting', detail: null }),
      ).headline,
    ).toBe('Refused answered while running: not_waiting');
  });

  it('carries the event identity through, so the page can order and key on it', () => {
    expect(describeEvent(ASKED)).toMatchObject({ seq: 3, ts: ASKED.ts, type: 'ask_user' });
  });

  it('shows a detail as text when it is text and as JSON when it is anything else', () => {
    const failed = { from: 'running', to: 'failed', cause: 'error', detail: 'the site timed out' };
    expect(describeEvent(event(1, 'transition', failed)).detail).toBe('the site timed out');
    const structured = { name: 'submit', outcome: 'refused', detail: { status: 403 } };
    expect(describeEvent(event(1, 'step', structured)).detail).toBe('{"status":403}');
    expect(describeEvent(event(1, 'transition', { from: 'a', to: 'b' })).headline).toBe('a → b');
  });

  it('shows an event whose payload is not its declared shape as itself rather than dropping it', () => {
    const cases: readonly [TaskEvent['type'], unknown][] = [
      ['transition', { from: 'queued' }],
      ['step', { outcome: 'ok' }],
      ['ask_user', { questionId: 'q-1' }],
      ['user_reply', 'a bare string'],
      ['rejected', { attempted: 'answered', status: 'running' }],
      ['step', null],
      ['step', ['not', 'an', 'object']],
    ];
    for (const [type, payload] of cases) {
      const entry = describeEvent(event(9, type, payload));
      expect(entry.headline, type).toBe(type);
      const shown =
        payload === null ? undefined : typeof payload === 'string' ? payload : JSON.stringify(payload);
      expect(entry.detail, type).toBe(shown);
    }
  });
});

describe('toView', () => {
  it('tells the trail oldest first whatever order it was handed in', () => {
    const view = toView(detail({ events: [REPLIED, ASKED] }));

    expect(view.timeline.map((entry) => entry.seq)).toEqual([3, 4]);
    expect(view.timeline.map((entry) => entry.type)).toEqual(['ask_user', 'user_reply']);
  });

  it('surfaces the open question of a task parked on one, and only then', () => {
    const parked = toView(detail({ status: 'waiting_user', events: [ASKED] }));
    expect(parked.pendingQuestion).toEqual({
      question: QUESTION,
      askedAt: '2026-08-30T10:00:03.000Z',
      expiresAt: '2026-08-30T22:00:03.000Z',
    });

    // Answered: nothing is pending even while the status has yet to move on.
    expect(toView(detail({ status: 'waiting_user', events: [ASKED, REPLIED] })).pendingQuestion).toBeUndefined();
    // Asked again after an answer: the second question is the open one.
    const again = event(5, 'ask_user', { questionId: 'q-2', question: 'Which plan?' });
    expect(toView(detail({ status: 'waiting_user', events: [ASKED, REPLIED, again] })).pendingQuestion).toEqual({
      question: 'Which plan?',
      askedAt: again.ts,
      expiresAt: undefined,
    });
    // A question with no text is not a question the reader can answer.
    expect(
      toView(detail({ status: 'waiting_user', events: [event(3, 'ask_user', { questionId: 'q-1' })] })).pendingQuestion,
    ).toBeUndefined();
    // Not parked: a stale question in the trail is history, not a prompt.
    expect(toView(detail({ status: 'succeeded', events: [ASKED] })).pendingQuestion).toBeUndefined();
  });

  it("points the player at this dashboard's own route only when there is a recording", () => {
    expect(toView(detail()).recordingHref).toBeUndefined();
    const withRecording = detail({ recording: { available: true, href: `/tasks/${TASK_ID}/recording` } });
    expect(toView(withRecording).recordingHref).toBe(`/tasks/${TASK_ID}/recording`);
  });

  it('carries the facts of the row through unchanged', () => {
    expect(toView(detail())).toMatchObject({
      id: TASK_ID,
      kind: 'cancel',
      status: 'succeeded',
      mode: 'playbook',
      createdAt: '2026-08-30T10:00:00.000Z',
      finishedAt: '2026-08-30T10:05:00.000Z',
    });
  });
});

describe('loadTaskDetail', () => {
  it('asks for exactly the task named and hands back its view', async () => {
    const asked: string[] = [];
    const client = stubClient({
      getTask: (id) => {
        asked.push(id);
        return Promise.resolve(detail({ events: [ASKED, REPLIED] }));
      },
    });

    const outcome = await loadTaskDetail(client, TASK_ID);

    expect(asked).toEqual([TASK_ID]);
    expect(outcome.kind).toBe('found');
    if (outcome.kind === 'found') expect(outcome.view.timeline).toHaveLength(2);
  });

  it('reports a task the API does not know as missing, whoever it belongs to', async () => {
    const client = stubClient({
      getTask: () => Promise.reject(new ApiError(404, 'not_found', 'No task belongs to you.', [])),
    });

    expect(await loadTaskDetail(client, TASK_ID)).toEqual({ kind: 'missing' });
  });

  it('reports any other refusal, and an API that did not answer, as a failure with a reason', async () => {
    const refusing = stubClient({
      getTask: () => Promise.reject(new ApiError(500, 'internal_error', 'Something broke.', [])),
    });
    expect(await loadTaskDetail(refusing, TASK_ID)).toEqual({ kind: 'failed', error: 'Something broke.' });

    const silent = stubClient({
      getTask: () => Promise.reject(new ApiUnreachableError('http://api.test/tasks/x', new Error('ECONNREFUSED'))),
    });
    expect(await loadTaskDetail(silent, TASK_ID)).toEqual({ kind: 'failed', error: 'the API did not answer' });
  });

  it('lets a defect in this process surface as one', async () => {
    const broken = stubClient({ getTask: () => Promise.reject(new TypeError('not a function')) });

    await expect(loadTaskDetail(broken, TASK_ID)).rejects.toThrow(TypeError);
  });
});
