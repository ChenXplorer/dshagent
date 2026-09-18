import type { Sandbox } from '@daytona/sdk';
import type { PersonalSandboxService } from '../sandbox-management/index.ts';
import type { DaemonRegistration, SandboxLease, SandboxProvider } from './index.ts';

/** Reuses the existing idempotent Daytona lifecycle adapter from the MVP. */
export class PersonalSandboxProvider implements SandboxProvider {
  readonly provider = 'daytona' as const;
  constructor(private readonly service: Pick<PersonalSandboxService, 'ensurePersonalSandbox' | 'pausePersonalSandbox' | 'resumePersonalSandbox'>,
    private readonly defaultDaemonFactory?: (userId: string) => Omit<DaemonRegistration, 'id' | 'createdAt' | 'updatedAt' | 'userId'>,
    private readonly closeProvider?: () => void | Promise<void>) {}
  async ensure(userId: string): Promise<SandboxLease> {
    const sandbox = await this.service.ensurePersonalSandbox(userId);
    return { id: sandbox.id, state: (sandbox as Sandbox).state };
  }
  async pause(userId: string): Promise<void> { await this.service.pausePersonalSandbox(userId); }
  async resume(userId: string): Promise<void> { await this.service.resumePersonalSandbox(userId); }
  async close(): Promise<void> { await this.closeProvider?.(); }
  defaultDaemon(userId: string): Omit<DaemonRegistration, 'id' | 'createdAt' | 'updatedAt' | 'userId'> | undefined { return this.defaultDaemonFactory?.(userId); }
}
