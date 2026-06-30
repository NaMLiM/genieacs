import { getRevision, getUiConfig, getUsers } from "./ui/local-cache.ts";
import { generateSalt, hashPassword } from "./auth.ts";
import { collections } from "./db/db.ts";
import * as MongoTypes from "./db/types.ts";
import {
  putConfig,
  putPermission,
  putPreset,
  putProvision,
  putUser,
  putView,
} from "./ui/db.ts";
import { del } from "./cache.ts";
import BOOTSTRAP_SCRIPT from "../seed/bootstrap.js" with { type: "text" };
import DEFAULT_SCRIPT from "../seed/default.js" with { type: "text" };
import INFORM_SCRIPT from "../seed/inform.js" with { type: "text" };
import OVERVIEW_PAGE from "../seed/overview-page.jsx" with { type: "text" };
import PIE_CHART from "../seed/pie-chart.jsx" with { type: "text" };
import DEVICE_PAGE from "../seed/device-page.jsx" with { type: "text" };
import DEVICE_PAGE_TR098 from "../seed/device-page-tr098.jsx" with { type: "text" };
import DEVICE_PAGE_TR181 from "../seed/device-page-tr181.jsx" with { type: "text" };
import PARAMETER from "../seed/parameter.jsx" with { type: "text" };
import SUMMON_BUTTON from "../seed/summon-button.jsx" with { type: "text" };
import ICON from "../seed/icon.jsx" with { type: "text" };
import DATAMODEL_EXPLORER from "../seed/datamodel-explorer.jsx" with { type: "text" };
import INSTANCE_TABLE from "../seed/instance-table.jsx" with { type: "text" };
import TAGS from "../seed/tags.jsx" with { type: "text" };

interface Status {
  users: boolean;
  presets: boolean;
  filters: boolean;
  device: boolean;
  index: boolean;
  overview: boolean;
}

type SeedPermission = Omit<MongoTypes.Permission, "_id">;

interface SeedUser {
  username: string;
  password: string;
  roles: string[];
}

interface SeedPreset {
  _id: string;
  weight: number;
  channel: string;
  events?: string;
  provision: string;
  [key: string]: unknown;
}

interface Resources {
  permissions?: SeedPermission[];
  users?: SeedUser[];
  config?: MongoTypes.Config[];
  views?: MongoTypes.View[];
  presets?: SeedPreset[];
  provisions?: MongoTypes.Provision[];
}

export async function getStatus(): Promise<Status> {
  const [configSnapshot, presetCount] = await Promise.all([
    getRevision(),
    collections.presets.countDocuments(),
  ]);
  const users = getUsers(configSnapshot);
  const ui = getUiConfig(configSnapshot);

  const status = {
    users: !Object.keys(users).length,
    presets: !presetCount,
    filters: true,
    device: true,
    index: true,
    overview: true,
  };

  // UI.index.* and UI.filters.* are stripped (hardcoded in frontend)
  // UI.device and UI.overview are preserved for device page & overview
  for (const k of Object.keys(ui)) {
    if (k === "device" || k.startsWith("device.")) status.device = false;
    if (k === "overview" || k.startsWith("overview.")) status.overview = false;
  }

  return status;
}

export async function seed(options: Record<string, boolean>): Promise<void> {
  const resources: Resources = {};
  const proms = [];

  if (options.users) {
    resources.permissions = [
      { role: "admin", resource: "devices", access: 3, validate: "true" },
      { role: "admin", resource: "faults", access: 3, validate: "true" },
      { role: "admin", resource: "files", access: 3, validate: "true" },
      { role: "admin", resource: "presets", access: 3, validate: "true" },
      { role: "admin", resource: "provisions", access: 3, validate: "true" },
      { role: "admin", resource: "config", access: 3, validate: "true" },
      { role: "admin", resource: "permissions", access: 3, validate: "true" },
      { role: "admin", resource: "users", access: 3, validate: "true" },
      {
        role: "admin",
        resource: "virtualParameters",
        access: 3,
        validate: "true",
      },
      {
        role: "admin",
        resource: "views",
        access: 3,
        validate: "true",
      },
    ];

    resources.users = [
      { username: "admin", password: "admin", roles: ["admin"] },
    ];
  }

  // UI.filters.* and UI.index.* are stripped — filters and columns are
  // hardcoded in the frontend (smart-query.ts, devices-page.ts).

  if (options.device) {
    resources.config = (resources.config || []).concat([
      { _id: "ui.device", value: "'device-page'" },
    ]);
    resources.views = (resources.views || []).concat([
      { _id: "device-page", script: DEVICE_PAGE },
      { _id: "device-page-tr098", script: DEVICE_PAGE_TR098 },
      { _id: "device-page-tr181", script: DEVICE_PAGE_TR181 },
      { _id: "parameter", script: PARAMETER },
      { _id: "summon-button", script: SUMMON_BUTTON },
      { _id: "icon", script: ICON },
      { _id: "datamodel-explorer", script: DATAMODEL_EXPLORER },
      { _id: "instance-table", script: INSTANCE_TABLE },
      { _id: "tags", script: TAGS },
    ]);
  }

  if (options.overview) {
    resources.config = (resources.config || []).concat([
      { _id: "ui.overview", value: "'overview-page'" },
    ]);
    resources.views = (resources.views || []).concat([
      { _id: "overview-page", script: OVERVIEW_PAGE },
      { _id: "pie-chart", script: PIE_CHART },
    ]);
  }

  if (options.presets) {
    resources.presets = [
      {
        _id: "bootstrap",
        weight: 0,
        channel: "bootstrap",
        events: "0 BOOTSTRAP",
        provision: "bootstrap",
      },
      { _id: "default", weight: 0, channel: "default", provision: "default" },
      { _id: "inform", weight: 0, channel: "inform", provision: "inform" },
    ];

    resources.provisions = [
      { _id: "bootstrap", script: BOOTSTRAP_SCRIPT },
      { _id: "default", script: DEFAULT_SCRIPT },
      { _id: "inform", script: INFORM_SCRIPT },
    ];
  }

  if (resources.permissions) {
    for (const p of resources.permissions) {
      const _id = `${p.role}:${p.resource}:${p.access}`;
      proms.push(putPermission(_id, p));
    }
  }

  if (resources.users) {
    for (const u of resources.users) {
      const salt = await generateSalt(64);
      const password = await hashPassword(u.password, salt);
      const roles = u.roles.join(",");
      proms.push(putUser(u.username, { password, salt, roles }));
    }
  }

  if (resources.provisions) {
    for (const p of resources.provisions) proms.push(putProvision(p._id, p));
  }

  if (resources.presets)
    for (const p of resources.presets) proms.push(putPreset(p._id, p));

  if (resources.views)
    for (const v of resources.views) proms.push(putView(v._id, v));

  if (resources.config)
    for (const c of resources.config) proms.push(putConfig(c._id, c));

  await Promise.all(proms);
  await Promise.all([del("ui-local-cache-hash"), del("cwmp-local-cache-hash")]);
}
