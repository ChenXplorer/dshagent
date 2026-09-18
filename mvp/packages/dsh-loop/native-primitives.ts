import type { AgentEventDispatch, Inbox, InboxTarget, InboxState } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent-loop';
import type { MessageId } from '@deepseek-ai/dsh-llm';
import type { Session, UserMessage } from '@deepseek-ai/dsh-session';
import type SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection';

// The compatibility patch exposes existing upstream implementations; these
// declarations describe that exact class rather than reimplementing its queue.
declare module '@deepseek-ai/dsh-agent-loop' {
  export const inboxProjectionDefinition: ProjectionDefinition<'inbox', InboxState>;
  export class ReactLoopInbox implements Inbox {
    constructor(projections: SessionProjectionRegistry, session: Session, dispatch: AgentEventDispatch);
    readonly nextTurn: readonly UserMessage[];
    readonly nextStep: readonly UserMessage[];
    readonly hasPending: boolean;
    clear(): void;
    claim(target: InboxTarget, turn: number): UserMessage[];
    append(target: InboxTarget, message: UserMessage): void;
    prepend(target: InboxTarget, message: UserMessage): void;
    replace(messageId: MessageId, newMessage: UserMessage): boolean;
    remove(messageId: MessageId): boolean;
    splice(target: InboxTarget, start: number, deleteCount: number, inserted: UserMessage[]): UserMessage[];
  }
}
export {};
