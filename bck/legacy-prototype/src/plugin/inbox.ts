import type { Inbox, InboxTarget, UserMessage } from "./types.ts";

export class MemoryInbox implements Inbox {
  private readonly lists: Record<InboxTarget, UserMessage[]> = {
    "next-turn": [],
    "next-step": [],
  };

  get nextTurn(): readonly UserMessage[] {
    return this.lists["next-turn"];
  }

  get nextStep(): readonly UserMessage[] {
    return this.lists["next-step"];
  }

  clear(): void {
    this.lists["next-step"] = [];
    this.lists["next-turn"] = [];
  }

  append(target: InboxTarget, message: UserMessage): void {
    this.lists[target].push(message);
  }

  prepend(target: InboxTarget, message: UserMessage): void {
    this.lists[target].unshift(message);
  }

  replace(messageId: string, newMessage: UserMessage): boolean {
    for (const target of ["next-turn", "next-step"] as const) {
      const list = this.lists[target];
      const index = list.findIndex((item) => item.id === messageId);
      if (index >= 0) {
        list[index] = newMessage;
        return true;
      }
    }
    return false;
  }

  remove(messageId: string): boolean {
    for (const target of ["next-turn", "next-step"] as const) {
      const list = this.lists[target];
      const index = list.findIndex((item) => item.id === messageId);
      if (index >= 0) {
        list.splice(index, 1);
        return true;
      }
    }
    return false;
  }

  splice(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
  ): UserMessage[] {
    return this.lists[target].splice(start, deleteCount, ...inserted);
  }

  claim(target: InboxTarget): UserMessage[] {
    return this.lists[target].splice(0, this.lists[target].length);
  }
}
