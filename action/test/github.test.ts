import { describe, expect, it } from 'vitest';
import { GitHubError, findOwnComment, githubClient } from '../lib/github.mjs';
import { MARKER } from '../lib/markdown.mjs';

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

/** A fetch stand-in that records calls and answers from `respond`. */
function fakeFetch(respond: (call: Call) => { status: number; json: unknown }) {
  const calls: Call[] = [];
  const impl = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const call = { url, method: init.method, headers: init.headers, body: init.body };
    calls.push(call);
    const { status, json } = respond(call);
    return new Response(JSON.stringify(json), { status });
  };
  return { calls, impl: impl as unknown as typeof fetch };
}

describe('findOwnComment', () => {
  const bot = { login: 'github-actions[bot]' };
  it('finds the comment that starts with the marker AND is written by the action', () => {
    const comments = [
      { id: 1, user: { login: 'mallory' }, body: `${MARKER}\nnot yours` },
      { id: 2, user: bot, body: `quoting ${MARKER}` },
      { id: 3, user: bot, body: `${MARKER}\n### 3D model diff` },
    ];
    expect(findOwnComment(comments, { marker: MARKER, author: bot.login })?.id).toBe(3);
    expect(findOwnComment(comments.slice(0, 2), { marker: MARKER, author: bot.login })).toBeNull();
    expect(findOwnComment(comments, { marker: MARKER, author: 'mallory' })?.id).toBe(1);
  });
});

describe('githubClient', () => {
  it('pages through every comment and sends the token', async () => {
    const all = Array.from({ length: 230 }, (_, i) => ({ id: i }));
    const { calls, impl } = fakeFetch((c) => {
      const page = Number(new URL(c.url).searchParams.get('page'));
      return { status: 200, json: all.slice((page - 1) * 100, page * 100) };
    });
    const api = githubClient({ token: 't0k', repo: 'o/r', apiUrl: 'https://ghe.example/api/v3/', fetchImpl: impl });
    expect((await api.listComments(7)).length).toBe(230);
    expect(calls.map((c) => c.url)).toEqual([1, 2, 3].map((p) => `https://ghe.example/api/v3/repos/o/r/issues/7/comments?per_page=100&page=${p}`));
    expect(calls[0].headers.authorization).toBe('Bearer t0k');
  });

  it('creates and updates comments with a JSON body', async () => {
    const { calls, impl } = fakeFetch(() => ({ status: 201, json: { id: 9 } }));
    const api = githubClient({ token: 't', repo: 'o/r', fetchImpl: impl });
    await api.createComment(7, 'hello');
    await api.updateComment(9, 'again');
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['POST', 'https://api.github.com/repos/o/r/issues/7/comments', '{"body":"hello"}'],
      ['PATCH', 'https://api.github.com/repos/o/r/issues/comments/9', '{"body":"again"}'],
    ]);
  });

  it('turns an error status into a GitHubError that keeps the status', async () => {
    const { impl } = fakeFetch(() => ({ status: 403, json: { message: 'Resource not accessible by integration' } }));
    const api = githubClient({ token: 't', repo: 'o/r', fetchImpl: impl });
    const err = await api.getPull(1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).status).toBe(403);
    expect(String((err as Error).message)).toContain('Resource not accessible by integration');
  });

  it('refuses a missing token or a malformed repository name', () => {
    expect(() => githubClient({ token: '', repo: 'o/r' })).toThrow(/token/);
    expect(() => githubClient({ token: 't', repo: 'o/r/../../x' })).toThrow(/repository/);
  });
});
