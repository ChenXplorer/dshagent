import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TaskDriver } from '../../packages/task-orchestration/index.ts';
import type { RuntimeTarget } from '../../packages/multica-client/index.ts';

type RuntimeRouteDriver = TaskDriver & {
  // Keep the route source-compatible with older test/integration drivers that
  // only implement the original kind-only selector.
  selectRuntime?: (sessionId: string, runtime: any) => Promise<void>;
};

/** Same-origin browser endpoint; the official DSH connection owns cookie/Host/Origin authentication. */
export function runtimeRoute(driver: RuntimeRouteDriver, dependencies: {
  rejection(req: IncomingMessage): number | undefined;
  agentBusy(sessionId: string): boolean;
}) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    const rejection = dependencies.rejection(req);
    if (rejection) return send(rejection, { error: '请重新打开 DSH 认证入口' });
    if (!['GET', 'POST'].includes(req.method ?? '')) return send(405, { error: 'Method not allowed' });
    const url = new URL(req.url ?? '/', 'http://localhost');
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId) || url.searchParams.getAll('sessionId').length !== 1) {
      return send(400, { error: '无效会话标识' });
    }
    if (!driver.runtimeState || !driver.selectRuntime) return send(503, { error: 'Runtime 服务尚未就绪' });
    const state = () => {
      const value = driver.runtimeState!(sessionId);
      return { ...value, busy: value.busy || dependencies.agentBusy(sessionId) };
    };
    try {
      if (req.method === 'POST') {
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(415, { error: 'Expected application/json' });
        let text = '';
        for await (const chunk of req) {
          text += chunk.toString();
          if (Buffer.byteLength(text) > 4096) return send(413, { error: 'Request too large' });
        }
        let input: Record<string, unknown>;
        try { input = JSON.parse(text); } catch { return send(400, { error: 'Invalid JSON' }); }
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['runtime', 'runtimeId', 'daemonId'].includes(key))) {
          return send(400, { error: '不支持的 Runtime 配置' });
        }
        const hasTarget = typeof input.runtimeId === 'string' || typeof input.daemonId === 'string';
        if (hasTarget && (typeof input.runtimeId !== 'string' || typeof input.daemonId !== 'string' || !['codex', 'claude-code'].includes(input.runtime as string))) {
          return send(400, { error: 'Runtime 选择需要 runtime、runtimeId 和 daemonId' });
        }
        if (!hasTarget && !['codex', 'claude-code'].includes(input.runtime as string)) return send(400, { error: '不支持的 Runtime 配置' });
        if (state().busy) return send(409, { error: '任务执行或对账中，请等待结束后切换' });
        await driver.selectRuntime(sessionId, hasTarget ? {
          kind: input.runtime as RuntimeTarget['kind'], runtimeId: input.runtimeId as string, daemonId: input.daemonId as string,
        } : input.runtime as 'codex' | 'claude-code');
      }
      const current = state();
      if (driver.listRuntimes) return send(200, { ...current, runtimes: await driver.listRuntimes() });
      return send(200, current);
    } catch { return send(409, { error: '切换失败，请等待任务收尾并刷新重试' }); }
  };
}
