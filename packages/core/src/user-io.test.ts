import { describe, expect, it, vi } from 'vitest';

import {
  scriptedUserIO,
  type UserAnswerSink,
  type UserQuestion,
  type UserResolution,
  type UserResolutionOutcome,
} from './user-io.js';

function question(n: number): UserQuestion {
  return {
    taskId: `task-${n}`,
    userId: 'user-1',
    questionId: `question-${n}`,
    question: `Question ${n}?`,
    askedAt: '2026-09-02T00:00:00.000Z',
    expiresAt: '2026-09-03T00:00:00.000Z',
  };
}

type SinkCall = readonly [taskId: string, questionId: string, resolution: UserResolution];

/** A sink that remembers what it was told and answers with one fixed verdict. */
function recordingSink(outcome: UserResolutionOutcome = { accepted: true }): {
  readonly sink: UserAnswerSink;
  readonly calls: SinkCall[];
} {
  const calls: SinkCall[] = [];
  return {
    calls,
    sink: {
      resolve(taskId, questionId, resolution) {
        calls.push([taskId, questionId, resolution]);
        return Promise.resolve(outcome);
      },
    },
  };
}

describe('scriptedUserIO', () => {
  it('plays the nth line to the nth question and keeps what the sink said', async () => {
    const { sink, calls } = recordingSink();
    const io = scriptedUserIO(sink, [{ kind: 'answer', reply: 'GYM-123456' }, { kind: 'decline' }]);

    await io.ask(question(1));
    await io.ask(question(2));
    await io.settled();

    expect(io.asked).toEqual([question(1), question(2)]);
    expect(calls).toEqual([
      ['task-1', 'question-1', { kind: 'answer', reply: 'GYM-123456' }],
      ['task-2', 'question-2', { kind: 'decline' }],
    ]);
    expect(io.outcomes).toEqual([{ accepted: true }, { accepted: true }]);
  });

  it('replies after ask has returned, never during it', async () => {
    const { sink, calls } = recordingSink();
    const io = scriptedUserIO(sink, [{ kind: 'answer', reply: 'yes' }]);

    await io.ask(question(1));
    // The engine has its answer to `ask` and has moved on; the person has not spoken yet.
    expect(calls).toEqual([]);

    await io.settled();
    expect(calls).toHaveLength(1);
  });

  it('leaves an ignored line, and any question past the end of the script, unanswered', async () => {
    const { sink, calls } = recordingSink();
    const io = scriptedUserIO(sink, [{ kind: 'ignore' }]);

    await io.ask(question(1));
    await io.ask(question(2));
    await io.settled();

    expect(io.asked).toHaveLength(2);
    expect(calls).toEqual([]);
    expect(io.outcomes).toEqual([]);
  });

  it('waits the configured delay before replying, and records a refusal as the sink gave it', async () => {
    vi.useFakeTimers();
    try {
      const { sink, calls } = recordingSink({ accepted: false, reason: 'not_waiting' });
      const io = scriptedUserIO(sink, [{ kind: 'answer', reply: 'late' }], { delayMs: 5_000 });

      await io.ask(question(1));
      await vi.advanceTimersByTimeAsync(4_999);
      expect(calls).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      await io.settled();
      expect(calls).toHaveLength(1);
      expect(io.outcomes).toEqual([{ accepted: false, reason: 'not_waiting' }]);
    } finally {
      vi.useRealTimers();
    }
  });
});
