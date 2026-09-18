import type { MulticaClient, MulticaTask, SubmitTaskResult } from "./types.ts";

const RETRIES = 8;
const DEFAULT_WAIT_MS = 25;

export async function submitWithReconcile(
  client: MulticaClient,
  input: Parameters<MulticaClient["submitTask"]>[0],
  options?: { waitMs?: number; retries?: number },
): Promise<Extract<SubmitTaskResult, { status: "accepted" }>> {
  const submitted = await client.submitTask(input);
  if (submitted.status === "accepted") return submitted;

  const waitMs = options?.waitMs ?? DEFAULT_WAIT_MS;
  const retries = options?.retries ?? RETRIES;
  let last: MulticaTask | undefined;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    last = await client.getTaskByClientRequestId(input.clientRequestId);
    if (last && last.status !== "unknown" && last.id) {
      return {
        status: "accepted",
        taskId: last.id,
        sessionId: last.sessionId ?? input.sessionId ?? "",
      };
    }
    await sleep(waitMs * (attempt + 1));
  }
  throw new Error(
    `Task submit state unknown after reconcile (clientRequestId=${input.clientRequestId}, last=${last?.status ?? "missing"})`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
