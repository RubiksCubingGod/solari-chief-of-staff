import type { UserQuestion } from '@chief-of-staff/core';
import { describe, expect, it, vi } from 'vitest';

import { createLogUserIO } from './user-io.js';

const question: UserQuestion = {
  taskId: 'task-1',
  userId: 'user-1',
  questionId: 'question-1',
  question: 'What is the confirmation code the gym sent you?',
  askedAt: '2026-09-02T10:00:00.000Z',
  expiresAt: '2026-09-03T10:00:00.000Z',
};

describe('createLogUserIO', () => {
  it('writes one JSON line per question, the kind first and then everything the ledger recorded', async () => {
    const lines: string[] = [];
    const io = createLogUserIO((line) => {
      lines.push(line);
    });
    await io.ask(question);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith('{"kind":"ask_user",')).toBe(true);
    expect(JSON.parse(lines[0] ?? '')).toEqual({ kind: 'ask_user', ...question });
  });

  it('writes to stdout unless told where else', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await createLogUserIO().ask(question);
      expect(write).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledWith(`${JSON.stringify({ kind: 'ask_user', ...question })}\n`);
    } finally {
      write.mockRestore();
    }
  });
});
