/**
 * The merge review's write routes, served only by `polymerge review` on a loopback address:
 *
 *   GET  /api/review/session  → what this session can save (IReviewSessionInfo)
 *   POST /api/review/save     → { picks, acknowledgeWarnings, expect } → save + git add
 *
 * Every request must pass, in order: a loopback Host and peer, the method, fetch metadata, the
 * Origin (POST), the token header, then (POST) the JSON content type and the size limit — all
 * before any body is parsed or any merge runs. No CORS header is ever sent, so a cross-origin
 * preflight always fails. Rationale: docs/write-back-security.md §4.1–§4.4, §4.10.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fetchSiteAllowed, hostAllowed, isLoopbackAddress, originAllowed, tokenMatches } from './serve-guard.js';
import type { ReviewWriteBack } from './write-back.js';

export const REVIEW_API_PREFIX = '/api/review/';
export const TOKEN_HEADER = 'x-polymerge-token';
export const MAX_SAVE_BODY = 64 * 1024;

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

/** Refuse, and close the connection rather than read a body nobody will look at. */
function refuse(res: ServerResponse, status: number, error: string, headers: Record<string, string> = {}): void {
  json(res, status, { ok: false, written: false, staged: false, error }, { connection: 'close', ...headers });
}

/** The body as text, or null when it exceeds `limit` bytes (reading stops there). */
function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) {
        req.off('data', onData);
        req.pause();
        resolve(null);
      } else chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function handleReviewApi(req: IncomingMessage, res: ServerResponse, pathname: string, port: number, session: ReviewWriteBack): Promise<void> {
  if (!hostAllowed(req.headers.host, port, true) || !isLoopbackAddress(req.socket.remoteAddress)) return refuse(res, 403, 'forbidden');
  const route = pathname.slice(REVIEW_API_PREFIX.length);
  const method = route === 'session' ? 'GET' : route === 'save' ? 'POST' : null;
  if (!method) return refuse(res, 404, 'not found');
  // OPTIONS (a CORS preflight) lands here too: 405, and no Access-Control-Allow-* ever.
  if (req.method !== method) return refuse(res, 405, 'method not allowed', { allow: method });
  if (!fetchSiteAllowed(req)) return refuse(res, 403, 'forbidden: cross-site request');
  if (method === 'POST' && !originAllowed(req.headers.origin, port)) return refuse(res, 403, 'forbidden: origin');
  if (!tokenMatches(req.headers[TOKEN_HEADER], session.token)) return refuse(res, 403, 'forbidden: token');
  if (method === 'GET') return json(res, 200, session.info());

  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return refuse(res, 415, 'the body must be application/json');
  if (Number(req.headers['content-length'] ?? 0) > MAX_SAVE_BODY) return refuse(res, 413, 'request body too large');
  const text = await readBody(req, MAX_SAVE_BODY);
  if (text === null) return refuse(res, 413, 'request body too large');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return refuse(res, 400, 'the body is not valid JSON');
  }
  const out = await session.save(body);
  json(res, out.status, out.body);
}
