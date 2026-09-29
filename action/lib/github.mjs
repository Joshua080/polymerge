/**
 * The few GitHub REST calls the post step makes (Node's fetch, no dependencies): read a pull
 * request, list / create / update its issue comments. `apiUrl` is $GITHUB_API_URL, so GitHub
 * Enterprise Server works, and the end-to-end test points it at a local mock server.
 */

export class GitHubError extends Error {
  constructor(method, route, status, message) {
    super(`GitHub API ${method} ${route} → ${status}${message ? `: ${message}` : ''}`);
    this.name = 'GitHubError';
    this.status = status;
  }
}

export function githubClient({ token, repo, apiUrl = 'https://api.github.com', fetchImpl = globalThis.fetch }) {
  if (!token) throw new Error('no GitHub token (the github-token input)');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error(`not a repository name: ${repo}`);
  const base = apiUrl.replace(/\/+$/, '');

  async function request(method, route, body) {
    const res = await fetchImpl(`${base}${route}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'polymerge-pr-diff',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // not JSON: reported by status below
    }
    if (!res.ok) throw new GitHubError(method, route, res.status, typeof json?.message === 'string' ? json.message.slice(0, 300) : '');
    return json;
  }

  return {
    getPull: (number) => request('GET', `/repos/${repo}/pulls/${number}`),
    /** Every comment on the pull request's conversation, oldest first (paginated). */
    async listComments(number) {
      const all = [];
      for (let page = 1; page <= 50; page++) {
        const batch = await request('GET', `/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
        if (!Array.isArray(batch)) throw new GitHubError('GET', 'comments', 200, 'not a list');
        all.push(...batch);
        if (batch.length < 100) break;
      }
      return all;
    },
    createComment: (number, body) => request('POST', `/repos/${repo}/issues/${number}/comments`, { body }),
    updateComment: (id, body) => request('PATCH', `/repos/${repo}/issues/comments/${id}`, { body }),
  };
}

/**
 * polymerge's comment on the pull request: the first comment whose body starts with `marker`,
 * written by `author` (by default the account GITHUB_TOKEN posts as). Anyone can paste the marker
 * into their own comment; the author check keeps the action from editing theirs.
 */
export function findOwnComment(comments, { marker, author }) {
  return comments.find((c) => typeof c.body === 'string' && c.body.startsWith(marker) && c.user?.login === author) ?? null;
}
