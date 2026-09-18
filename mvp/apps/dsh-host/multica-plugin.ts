import { runtimeRoute } from './runtime-route.ts';
import { SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-client-connection';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installMulticaFactory } from '../../packages/dsh-loop/index.ts';
import type { TaskDriver } from '../../packages/task-orchestration/index.ts';
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller';
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import { startGateway } from './gateway.ts';
import { skillRoute } from './skill-route.ts';
type Context = Parameters<typeof installMulticaFactory>[0];

export const name = 'mvp-multica-loop';
// The optional DSH registry bridge reads the official `ctx.skills` service.
// Inject it here so createDriver can use the provider registry without
// reaching through Cordis' guarded service properties.
export const inject = ['agents', 'sessions', 'sessionProjections', 'sessionPersistence', 'skills'];

export async function apply(ctx: Context): Promise<void> {
  const path = process.env.DSH_MVP_DRIVER_MODULE;
  if (!path || !isAbsolute(path)) throw new Error('DSH_MVP_DRIVER_MODULE must identify the real deployment driver module');
  const module = await import(pathToFileURL(path).href) as { createDriver?: (input: { ctx: Context }) => Promise<TaskDriver> };
  if (!module.createDriver) throw new Error('Driver module must export createDriver({ctx}); no default model fallback exists');
  const driver = await module.createDriver({ ctx });
  installMulticaFactory(ctx, driver);
  ctx.inject(['webServer', 'connection'], webCtx => {
    webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path: '/mvp/runtime',
      handler: runtimeRoute(driver, {
        rejection: req => webCtx.connection.requestRejection(req),
        agentBusy: id => {
          const agent = webCtx.agents.get(SessionId(id));
          return agent?.status === 'running';
        },
      }),
    }));
    webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path: '/mvp/skills',
      handler: skillRoute(driver, { rejection: req => webCtx.connection.requestRejection(req) }),
    }));
  });
  // Register the per-user host directory with DSH's own workspace registry.
  // `create()` is idempotent: on restart it returns the existing workspace and
  // lets the official Web client discover sessions whose cwd is this directory.
  ctx.inject(['workspaceRegistry', 'sessionController'], async gatewayCtx => {
    const token = process.env.DSH_MVP_GATEWAY_TOKEN;
    const userId = process.env.DSH_MVP_USER_ID;
    const cwd = process.env.DSH_MVP_HOST_WORKSPACE;
    if (!token || !userId || !cwd) throw new Error('Gateway requires DSH_MVP_GATEWAY_TOKEN, DSH_MVP_USER_ID and DSH_MVP_HOST_WORKSPACE');
    const workspaceRegistry = gatewayCtx.get('workspaceRegistry') as unknown as WorkspaceRegistry;
    await workspaceRegistry.create(cwd, 'Workspace');
    const controller = gatewayCtx.get('sessionController') as unknown as SessionController;
    const close = await startGateway(controller, driver, { token, userId, cwd, port: Number(process.env.DSH_MVP_GATEWAY_PORT ?? 3380) });
    try { gatewayCtx.fiber.assertActive(); gatewayCtx.effect(() => close); }
    catch (error) { await close(); throw error; }
  });
}
