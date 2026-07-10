/**
 * PPPoE Provisioning Module
 *
 * "Highly integrated" approach — replaces the sandbox provision script +
 * billing-bridge extension with a compiled TypeScript module.
 *
 * - Reads config from GenieACS database config (visible in UI Config page)
 * - Calls billing API inline (no IPC to extension processes)
 * - Discovers existing WAN PPP connections via device.unpack()
 * - Handles vendor-specific VLAN quirks (Zion, Huawei, ZTE)
 * - Runs only on first connect / factory reset (Tags.Provisioned guard)
 *
 * Data collection strategy:
 *   Bootstrap (first/reset) → full device info + PPPoE staging
 *   Regular informs    → lightweight (WAN IP, device list)
 */

import Path from "../common/path.ts";
import { SessionContext, Declaration } from "../types.ts";
import * as localCache from "../cwmp/local-cache.ts";
import Expression from "../common/expression.ts";

/* ------------------------------------------------------------------ */
/*  Config helpers                                                     */
/* ------------------------------------------------------------------ */

function constLiteral(e: Expression): Expression.Literal {
  if (e instanceof Expression.Literal) return e;
  return new Expression.Literal(null);
}

function getConfigStr(
  sessionContext: SessionContext,
  key: string,
  dflt: string,
): string {
  return localCache.getConfig(
    sessionContext.cacheSnapshot, key, dflt, constLiteral,
  ) as string;
}

function getConfigNum(
  sessionContext: SessionContext,
  key: string,
  dflt: number,
): number {
  return localCache.getConfig(
    sessionContext.cacheSnapshot, key, dflt, constLiteral,
  ) as number;
}

/* ------------------------------------------------------------------ */
/*  Billing API call                                                   */
/* ------------------------------------------------------------------ */

interface BillingAccount {
  username: string;
  password: string;
}

async function fetchBillingAccount(
  apiUrl: string,
  apiKey: string,
  serialNumber: string,
): Promise<BillingAccount | null> {
  const url = `${apiUrl.replace(/\/+$/, "")}/${encodeURIComponent(serialNumber)}`;

  try {
    const res = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      console.error(`[PPPoE] Billing API returned ${res.status} for SN ${serialNumber}`);
      return null;
    }

    const data = await res.json() as any;

    if (data?.data?.customer?.username && data?.data?.customer?.password) {
      return {
        username: String(data.data.customer.username),
        password: String(data.data.customer.password),
      };
    }

    console.error(`[PPPoE] Billing API response missing username/password for SN ${serialNumber}`);
    return null;
  } catch (err) {
    console.error(`[PPPoE] Billing API error for SN ${serialNumber}:`, (err as Error).message);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  VLAN helpers                                                       */
/* ------------------------------------------------------------------ */

function buildDecl(
  pathStr: string,
  attrGet: Declaration["attrGet"],
  attrSet: Declaration["attrSet"],
  opts?: { pathSet?: number },
): Declaration {
  return {
    path: Path.parse(pathStr),
    pathGet: 1,
    pathSet: opts?.pathSet ?? undefined,
    attrGet: attrGet ?? undefined,
    attrSet: attrSet ?? undefined,
    defer: true,
  };
}

function getVlanDeclarations(
  containerPath: string,
  manufacturer: string,
  productClass: string,
  vlanId: number,
): Declaration[] {
  if (manufacturer.toUpperCase().includes("ZION")) {
    return [buildDecl(`${containerPath}.WANPPPConnection.1.VLAN_ID`, { value: 1 }, { value: [vlanId] })];
  }
  if (manufacturer.includes("Huawei") || productClass.includes("HG")) {
    return [buildDecl(`${containerPath}.X_HW_VLAN`, { value: 1 }, { value: [vlanId] })];
  }
  if (manufacturer.includes("ZTE") || productClass.includes("F6")) {
    return [buildDecl(`${containerPath}.X_CT-COM_VLAN`, { value: 1 }, { value: [vlanId] })];
  }
  // Standard TR-098 fallback
  return [buildDecl(`${containerPath}.WANDSLLinkConfig.VLANID`, { value: 1 }, { value: [vlanId] })];
}

/* ------------------------------------------------------------------ */
/*  WAN discovery                                                      */
/* ------------------------------------------------------------------ */

interface WanPppInfo {
  deviceIdx: number;
  connectionPath: string;
  pppPath: string;
  username: string;
}

function readExistingWanPpp(sessionContext: SessionContext): WanPppInfo[] {
  const results: WanPppInfo[] = [];

  for (let i = 1; i <= 8; i++) {
    const pppPath = `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${i}.WANPPPConnection.1`;
    const pathStr = `${pppPath}.Username`;
    const resolved = sessionContext.deviceData.paths.get(pathStr);
    if (!resolved) continue;

    const attrs = sessionContext.deviceData.attributes.get(resolved);
    if (!attrs?.value?.[1]) continue;

    const username = String(attrs.value[1][0]);
    results.push({
      deviceIdx: i,
      connectionPath: `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${i}`,
      pppPath,
      username,
    });
  }

  return results;
}

/* ------------------------------------------------------------------ */
/*  Refresh declarations                                               */
/* ------------------------------------------------------------------ */

function getBootstrapRefreshDeclarations(sessionContext: SessionContext): Declaration[] {
  const t = sessionContext.timestamp;

  return [
    "DeviceID.Manufacturer",
    "DeviceID.ProductClass",
    "DeviceID.SerialNumber",
    "DeviceID.OUI",
    "InternetGatewayDevice.DeviceInfo.ManufacturerOUI",
    "InternetGatewayDevice.DeviceInfo.HardwareVersion",
    "InternetGatewayDevice.DeviceInfo.SoftwareVersion",
    "InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.MACAddress",
    "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.{i}.WANPPPConnection.1.Username",
    "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.{i}.WANPPPConnection.1.Enable",
    "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.{i}.WANPPPConnection.1.ConnectionType",
    "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.{i}.WANIPConnection.1.ExternalIPAddress",
  ].map((p) => ({
    path: Path.parse(p),
    pathGet: 1,
    pathSet: undefined as undefined,
    attrGet: { value: t } as Declaration["attrGet"],
    attrSet: undefined as undefined,
    defer: true as const,
  }));
}

function getLightweightRefreshDeclarations(sessionContext: SessionContext): Declaration[] {
  const t = sessionContext.timestamp;

  return [
    "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.{i}.WANIPConnection.1.ExternalIPAddress",
    "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.{i}.WANPPPConnection.1.ExternalIPAddress",
    "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.{i}.WANPPPConnection.1.ConnectionStatus",
    "InternetGatewayDevice.WANDevice.1.WANPPPConnection.1.Enable",
    "DeviceID.Manufacturer",
    "DeviceID.ProductClass",
    "DeviceID.SerialNumber",
  ].map((p) => ({
    path: Path.parse(p),
    pathGet: 1,
    pathSet: undefined as undefined,
    attrGet: { value: t } as Declaration["attrGet"],
    attrSet: undefined as undefined,
    defer: true as const,
  }));
}

/* ------------------------------------------------------------------ */
/*  Tag helpers                                                        */
/* ------------------------------------------------------------------ */

function isProvisioned(sessionContext: SessionContext): boolean {
  const syncState = sessionContext.syncState;
  if (!syncState) return false;
  const tagPath = Path.parse("Provisioned");
  return syncState.tags.get(tagPath) === true;
}

function setProvisionedTagDecl(): Declaration {
  return {
    path: Path.parse("Tags.Provisioned"),
    pathGet: 1,
    pathSet: undefined,
    attrGet: { value: 1 },
    attrSet: { value: [true] },
    defer: true,
  };
}

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

const STATE_KEY = "__pppoe_state__";

interface PppoeState {
  billingFetched: boolean;
  account: BillingAccount | null;
  serialNumber: string;
  lightweightInjected: boolean;
  bootstrapDone: boolean;
}

function getState(sessionContext: SessionContext): PppoeState {
  let s = sessionContext.extensionsCache[STATE_KEY] as PppoeState | undefined;
  if (!s) {
    s = { billingFetched: false, account: null, serialNumber: "", lightweightInjected: false, bootstrapDone: false };
    sessionContext.extensionsCache[STATE_KEY] = s;
  }
  return s;
}

/* ------------------------------------------------------------------ */
/*  Value reader                                                       */
/* ------------------------------------------------------------------ */

function getParamValueStr(sessionContext: SessionContext, pathStr: string): string {
  const resolved = sessionContext.deviceData.paths.get(pathStr);
  if (!resolved) return "";
  const attrs = sessionContext.deviceData.attributes.get(resolved);
  if (!attrs?.value?.[1]) return "";
  return String(attrs.value[1][0]);
}

/* ------------------------------------------------------------------ */
/*  Declaration factories                                              */
/* ------------------------------------------------------------------ */

function setStrDecl(pathStr: string, val: string): Declaration {
  return {
    path: Path.parse(pathStr),
    pathGet: 1,
    pathSet: undefined,
    attrGet: { value: 1 },
    attrSet: { value: [val] },
    defer: true,
  };
}

function setBoolDecl(pathStr: string, val: boolean): Declaration {
  return {
    path: Path.parse(pathStr),
    pathGet: 1,
    pathSet: undefined,
    attrGet: { value: 1 },
    attrSet: { value: [val] },
    defer: true,
  };
}

/* ------------------------------------------------------------------ */
/*  Main entry point                                                   */
/* ------------------------------------------------------------------ */

export async function provisionPppoe(
  sessionContext: SessionContext,
): Promise<Declaration[]> {
  const state = getState(sessionContext);
  const timestamp = sessionContext.timestamp;

  /* ---------- Guard: bootstrap already done → lightweight refresh ---------- */
  if (state.bootstrapDone) {
    if (!state.lightweightInjected) {
      state.lightweightInjected = true;
      return getLightweightRefreshDeclarations(sessionContext);
    }
    return [];
  }

  /* ---------- Guard: already provisioned (from DB) → lightweight refresh ---------- */
  if (isProvisioned(sessionContext)) {
    state.bootstrapDone = true;
    if (!state.lightweightInjected) {
      state.lightweightInjected = true;
      return getLightweightRefreshDeclarations(sessionContext);
    }
    return [];
  }

  /* ---------- Read device identity from inform data ---------- */
  if (!state.serialNumber) {
    state.serialNumber = getParamValueStr(sessionContext, "DeviceID.SerialNumber");
  }

  const manufacturer = getParamValueStr(sessionContext, "DeviceID.Manufacturer");
  const productClass = getParamValueStr(sessionContext, "DeviceID.ProductClass");

  /* ---------- Phase 1: no CPE WAN data yet — request it ---------- */
  const existingWans = readExistingWanPpp(sessionContext);
  const hasWanData = existingWans.length > 0 ||
    !!sessionContext.deviceData.paths.get("InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.Enable");

  if (!hasWanData) {
    return getBootstrapRefreshDeclarations(sessionContext);
  }

  /* ---------- Phase 2: CPE data available — fetch billing ---------- */
  if (!state.billingFetched) {
    const apiKey = getConfigStr(sessionContext, "pppoe.apiKey", "");
    // URL is fixed infrastructure — API key identifies the tenant
    const apiUrl = "https://murnimakmurabadi.id/api/pppoe";

    if (!apiKey) {
      console.warn("[PPPoE] pppoe.apiKey not configured — tagging as provisioned");
      state.bootstrapDone = true;
      return [setProvisionedTagDecl()];
    }

    state.account = await fetchBillingAccount(apiUrl, apiKey, state.serialNumber);
    state.billingFetched = true;

    if (!state.account) {
      console.warn(`[PPPoE] No billing account for SN ${state.serialNumber} — tagging as provisioned`);
      state.bootstrapDone = true;
      return [setProvisionedTagDecl()];
    }
  }

  /* ---------- Phase 3: decide what to do ---------- */
  if (!state.account) {
    return [setProvisionedTagDecl()];
  }

  const { username, password } = state.account;
  const vlanId = getConfigNum(sessionContext, "pppoe.vlanId", 246);
  const wanIndex = getConfigNum(sessionContext, "pppoe.fallbackWanIndex", 3);
  const decls: Declaration[] = [];

  state.bootstrapDone = true;

  // Scan existing WAN PPP instances
  let foundMatch = false;
  let testPath: string | null = null;
  let testConnectionPath: string | null = null;

  for (const wan of existingWans) {
    if (wan.username === username) {
      foundMatch = true;
      break;
    }
    if (wan.username === "test") {
      testPath = wan.pppPath;
      testConnectionPath = wan.connectionPath;
    }
  }

  if (foundMatch) {
    decls.push(setProvisionedTagDecl());
  } else if (testPath) {
    decls.push(
      setStrDecl(`${testPath}.Username`, username),
      setStrDecl(`${testPath}.Password`, password),
      setBoolDecl(`${testPath}.Enable`, true),
      setBoolDecl(`${testPath}.NATEnabled`, true),
    );
    if (testConnectionPath) {
      decls.push(...getVlanDeclarations(testConnectionPath, manufacturer, productClass, vlanId));
    }
    decls.push(setProvisionedTagDecl());
  } else {
    const targetWan = `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${wanIndex}`;
    const targetPpp = `${targetWan}.WANPPPConnection.1`;

    // Disable WAN 2
    decls.push(setBoolDecl("InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.Enable", false));

    // Ensure PPP object exists
    decls.push({
      path: Path.parse(targetPpp),
      pathGet: 1,
      pathSet: 1,
      attrGet: undefined,
      attrSet: undefined,
      defer: true,
    });

    // VLAN
    decls.push(...getVlanDeclarations(targetWan, manufacturer, productClass, vlanId));

    // PPPoE config
    decls.push(
      setBoolDecl(`${targetPpp}.Enable`, true),
      setStrDecl(`${targetPpp}.ConnectionType`, "IP_Routed"),
      setBoolDecl(`${targetPpp}.NATEnabled`, true),
      setStrDecl(`${targetPpp}.Username`, username),
      setStrDecl(`${targetPpp}.Password`, password),
    );

    decls.push(setProvisionedTagDecl());
  }

  return decls;
}
