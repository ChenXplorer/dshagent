import { MulticaDaemon } from "./daemon.ts";

const serverUrl =
  process.env["MULTICA_SERVER_URL"] ?? "http://127.0.0.1:8080/api/multica";
const machineId = process.env["MULTICA_MACHINE_ID"] ?? "cube-personal";

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    try {
      const response = await fetch(`${serverUrl}/health`);
      if (response.ok) return;
    } catch {
      /* still booting */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Multica Server did not become ready");
}

const daemon = new MulticaDaemon({ serverUrl, machineId });

process.on("SIGTERM", () => {
  void daemon.stop().then(() => process.exit(0));
});
process.on("SIGINT", () => {
  void daemon.stop().then(() => process.exit(0));
});

await waitForServer();
await daemon.start();
console.log(
  `multica daemon online machine=${machineId} tools=${daemon
    .hello()
    .tools.map((tool) => tool.runtime)
    .join(",")}`,
);
