import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TaskDriver } from '../../packages/task-orchestration/index.ts';
import type { DshManagedSkill } from '../../packages/skill-distribution/index.ts';

type SkillRouteDriver = TaskDriver;

function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk.toString();
    if (Buffer.byteLength(raw) > 512 * 1024) throw new Error('请求体过大');
  }
  let value: unknown;
  try { value = JSON.parse(raw || '{}'); }
  catch { throw new Error('无效 JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求体必须是对象');
  return value as Record<string, unknown>;
}

/** Same-origin browser endpoint for the global DSH Skill controls in the Web UI. */
export function skillRoute(driver: SkillRouteDriver, dependencies: {
  rejection(req: IncomingMessage): number | undefined;
}) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const rejection = dependencies.rejection(req);
    if (rejection) return send(res, rejection, { error: '请重新打开 DSH 认证入口' });
    if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'PUT') return send(res, 405, { error: 'Method not allowed' });
    if (!driver.listManagedSkills || !driver.setManagedSkillEnabled) {
      return send(res, 503, { error: 'Skill 服务尚未就绪' });
    }
    try {
      if (req.method === 'GET') return send(res, 200, await driver.listManagedSkills());
      const input = await readJson(req);
      if (req.method === 'PUT') {
        if (!driver.replaceManagedSkills || Object.keys(input).some(key => key !== 'skills') || !Array.isArray(input.skills)) {
          return send(res, 400, { error: 'Skill 替换需要 skills 数组' });
        }
        return send(res, 200, await driver.replaceManagedSkills(input.skills as DshManagedSkill[]));
      }
      if (Object.keys(input).some(key => !['key', 'enabled'].includes(key)) || typeof input.key !== 'string' || typeof input.enabled !== 'boolean') {
        return send(res, 400, { error: 'Skill 配置需要 key 和 enabled' });
      }
      return send(res, 200, await driver.setManagedSkillEnabled(input.key, input.enabled));
    } catch (error) {
      return send(res, 409, { error: error instanceof Error ? error.message : 'Skill 操作失败，请刷新重试' });
    }
  };
}
