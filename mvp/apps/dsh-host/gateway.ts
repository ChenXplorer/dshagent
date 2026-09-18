import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionController, SessionPromptRequest } from '@deepseek-ai/dsh-api-session-controller';
import type { TaskDriver } from '../../packages/task-orchestration/index.ts';
import type { RuntimeTarget } from '../../packages/multica-client/index.ts';

type Controller = Pick<SessionController, 'create' | 'prompt' | 'cancel' | 'follow'>;
type RuntimeDriver = TaskDriver & { selectRuntime?: (sessionId: string, runtime: 'codex' | 'claude-code' | RuntimeTarget) => Promise<void> };
class RequestError extends Error { constructor(readonly status: number, message: string) { super(message); } }

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); length += bytes.length;
    if (length > 256 * 1024) throw new RequestError(413, 'Request body exceeds 256 KiB');
    chunks.push(bytes);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new RequestError(400, 'Invalid JSON body'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestError(400, 'Expected a JSON object');
  return value as Record<string, unknown>;
}
const requiredText = (value: unknown, name: string) => {
  if (typeof value !== 'string' || !value.trim()) throw new RequestError(400, `${name} is required`);
  return value;
};
const json = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
};

/** MVP-owned Gateway routes. Every session operation invokes the actual DSH business API. */
export async function startGateway(controller: Controller, driver: RuntimeDriver, options: {
  token: string; userId: string; cwd: string; port?: number;
}): Promise<() => Promise<void>> {
  if (options.token.length < 32 || !options.userId || !options.cwd) throw new Error('Gateway requires a >=32 character token, fixed userId and host cwd');
  const port = options.port ?? 3380;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Gateway port');
  const token = Buffer.from(`Bearer ${options.token}`);
  const streams = new Set<AbortController>();
  const server = createServer((req, res) => { void (async () => {
    const authorization = Buffer.from(req.headers.authorization ?? '');
    if (authorization.length !== token.length || !timingSafeEqual(authorization, token)) throw new RequestError(401, 'Unauthorized');
    // This MVP has a fixed trusted identity. Request bodies cannot impersonate another user.
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/v1/health') return json(res, 200, { ready: true, userId: options.userId, engine: 'multica', busy: driver.isBusy?.() ?? false });
    if (req.method === 'GET' && url.pathname === '/v1/runtimes') {
      if (!driver.listRuntimes) throw new RequestError(503, 'Runtime catalog is unavailable');
      return json(res, 200, { runtimes: await driver.listRuntimes() });
    }
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    if (req.method === 'POST' && url.pathname === '/v1/sessions') {
      const input = await body(req);
      if ('userId' in input || 'cwd' in input) throw new RequestError(400, 'Identity and host workspace are deployment configuration');
      const created = await controller.create({ cwd: options.cwd, ...input.sessionId ? { sessionId: SessionId(requiredText(input.sessionId, 'sessionId')) } : {} });
      return json(res, 201, created);
    }
    const match = /^\/v1\/sessions\/([^/]+)\/(messages|cancel|events|runtime)$/.exec(url.pathname);
    if (!match) throw new RequestError(404, 'Route not found');
    const sessionId = SessionId(decodeURIComponent(match[1]!));
    if (req.method === 'GET' && match[2] === 'events') {
      streams.add(abort);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      try {
        for await (const frame of controller.follow({ address: { kind: 'session', sessionId }, assistantStream: true }, abort.signal)) {
          if (abort.signal.aborted) break;
          if (!res.write(`data: ${JSON.stringify(frame)}\n\n`)) await once(res, 'drain', { signal: abort.signal });
        }
      } finally { streams.delete(abort); res.end(); }
      return;
    }
    if (req.method !== 'POST') throw new RequestError(405, 'Method not allowed');
    const input = await body(req);
    if ('userId' in input) throw new RequestError(400, 'Identity is deployment configuration');
    if (match[2] === 'cancel') return json(res, 202, controller.cancel({ sessionId }));
    if (match[2] === 'runtime') {
      const target = typeof input.runtimeId === 'string' || typeof input.daemonId === 'string' ? {
        kind: input.runtime as RuntimeTarget['kind'], runtimeId: input.runtimeId, daemonId: input.daemonId,
      } : undefined;
      if (target && (target.kind !== 'codex' && target.kind !== 'claude-code' || typeof target.runtimeId !== 'string' || typeof target.daemonId !== 'string')) {
        throw new RequestError(400, 'Runtime target requires runtime, runtimeId and daemonId');
      }
      if (!target && input.runtime !== 'codex' && input.runtime !== 'claude-code') throw new RequestError(400, 'Unsupported runtime');
      if (!driver.selectRuntime) throw new RequestError(503, 'Runtime selection is unavailable');
      await driver.selectRuntime(sessionId, target ? target as RuntimeTarget : input.runtime as 'codex' | 'claude-code');
      return json(res, 200, { selected: target ?? input.runtime });
    }
    if (match[2] === 'messages') {
      if (input.mode !== undefined && input.mode !== 'queue' && input.mode !== 'steer') throw new RequestError(400, 'Unsupported delivery mode');
      const receipt = await controller.prompt({ sessionId, requestId: requiredText(input.requestId, 'requestId') as SessionPromptRequest['requestId'],
        mode: input.mode ?? 'queue', content: [{ type: 'text', text: requiredText(input.text, 'text') }] }, abort.signal);
      return json(res, 202, receipt);
    }
    throw new RequestError(404, 'Route not found');
  })().catch(error => {
    if (res.destroyed) return;
    if (res.headersSent) { res.destroy(); return; }
    // Secrets/upstream response bodies stay in deployment logs, not the Gateway wire.
    json(res, error instanceof RequestError ? error.status : 409,
      { error: error instanceof RequestError ? error.message : 'DSH operation failed; inspect host logs and session state' });
  }); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return async () => {
    for (const controller of streams) controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
}
