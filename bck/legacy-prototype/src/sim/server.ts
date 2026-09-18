import { MulticaControlPlane } from "../multica/control-plane.ts";
import { loadOfficialConfig, OfficialMulticaPlane } from "../multica/official.ts";

let instance: MulticaControlPlane | OfficialMulticaPlane | undefined;

/** Process-wide plane used by `/api/multica`. Prefers local official Server. */
export function getMulticaGateway(): MulticaControlPlane | OfficialMulticaPlane {
  const official = loadOfficialConfig();
  if (official) {
    if (!isOfficial(instance)) instance = new OfficialMulticaPlane(official);
    return instance;
  }
  if (!instance || isOfficial(instance)) instance = new MulticaControlPlane();
  return instance;
}

export function resetMulticaGateway(
  plane?: MulticaControlPlane | OfficialMulticaPlane,
): MulticaControlPlane | OfficialMulticaPlane {
  if (plane) {
    instance = plane;
    return instance;
  }
  instance = undefined;
  return getMulticaGateway();
}

function isOfficial(
  value: MulticaControlPlane | OfficialMulticaPlane | undefined,
): value is OfficialMulticaPlane {
  return Boolean(value && "kind" in value && value.kind === "official");
}