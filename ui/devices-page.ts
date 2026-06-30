import { m as mContext } from "./components.ts";
import { createMithrilHost } from "./mithril-compat.ts";
import { navigate } from "./router.ts";
import { pageSize as PAGE_SIZE } from "./config.ts";
import { createFilter } from "./filter-component.ts";
import { createIndexTable } from "./index-table-component.ts";
import {
  pagedFetch,
  count as reactiveCount,
  createBookmark,
  invalidate,
} from "./reactive-store.ts";
import * as store from "./legacy-store.ts";
import { StateSignal } from "./signals.ts";
import { deleteResource, updateTags } from "./api-client.ts";
import { queueTask, stageDownload } from "./task-queue.ts";
import * as notifications from "./notifications.ts";
import Expression, { extractPaths } from "../lib/common/expression.ts";
import Path from "../lib/common/path.ts";
import * as smartQuery from "./smart-query.ts";
import { renderView } from "./views.ts";
import { div, h1, button, a, span } from "./dom.ts";

// ── Custom device table columns (hardcoded, stripped from UI.* config) ──
const CUSTOM_COLUMNS = [
  // 1. Status — overview-dot colored by online/offline chart
  {
    label: "Status",
    type: "container",
    parameter: Expression.parse("DATE_STRING(Events.Inform)"),
    element: "span.status",
    unsortable: false,
    raw: {
      components: {
        "0": { type: new Expression.Literal("parameter") },
        "1": {
          type: new Expression.Literal("overview-dot"),
          chart: new Expression.Literal("online"),
        },
      },
      element: new Expression.Literal("span.status"),
    },
  },
  // 2. Username
  {
    label: "Username",
    parameter: Expression.parse("DeviceID.ID"),
    unsortable: false,
    raw: {},
  },
  // 3. SSID
  {
    label: "SSID",
    parameter:
      Expression.parse("InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID"),
    unsortable: false,
    raw: {},
  },
  // 4. RX — multi-vendor received signal power (TP-Link/Huawei/ZTE)
  // Rendered inline in valueCallback to coalesce across vendor paths
  {
    label: "RX",
    parameter:
      Expression.parse(
        "InternetGatewayDevice.DeviceInfo.X_TP_RxPower",
      ),
    unsortable: true,
    raw: {},
  },
  // 5. Temp — multi-vendor temperature
  {
    label: "Temp",
    parameter:
      Expression.parse(
        "InternetGatewayDevice.DeviceInfo.X_TP_Temperature",
      ),
    unsortable: true,
    raw: {},
  },
  // 6. Uptime
  {
    label: "Uptime",
    parameter:
      Expression.parse("InternetGatewayDevice.DeviceInfo.UpTime"),
    unsortable: false,
    raw: {},
  },
  // 7. IP PPPoE/Static (WAN IP)
  {
    label: "IP PPPoE/Static",
    parameter:
      Expression.parse(
        "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress",
      ),
    unsortable: false,
    raw: {},
  },
  // 8. IP TR069
  {
    label: "IP TR069",
    parameter:
      Expression.parse(
        "InternetGatewayDevice.ManagementServer.ConnectionRequestURL",
      ),
    unsortable: false,
    raw: {},
  },
  // 9. SN (Serial Number) — clickable link
  {
    label: "SN",
    type: "device-link",
    parameter: Expression.parse("DeviceID.SerialNumber"),
    unsortable: false,
    raw: {
      components: {
        "0": { type: new Expression.Literal("parameter") },
      },
    },
  },
  // 10. MAC
  {
    label: "MAC",
    parameter:
      Expression.parse(
        "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.MACAddress",
      ),
    unsortable: false,
    raw: {},
  },
  // 11. Product
  {
    label: "Product",
    parameter: Expression.parse("DeviceID.ProductClass"),
    unsortable: false,
    raw: {},
  },
  // 12. Software Rev
  {
    label: "Software Rev",
    parameter:
      Expression.parse(
        "InternetGatewayDevice.DeviceInfo.SoftwareVersion",
      ),
    unsortable: false,
    raw: {},
  },
  // 13. Last Inform
  {
    label: "Last Inform",
    type: "container",
    parameter: Expression.parse("DATE_STRING(Events.Inform)"),
    element: "span.inform",
    unsortable: false,
    raw: {
      components: {
        "0": { type: new Expression.Literal("parameter") },
        "1": {
          type: new Expression.Literal("overview-dot"),
          chart: new Expression.Literal("online"),
        },
      },
      element: new Expression.Literal("span.inform"),
    },
  },
  // 14. Tag
  {
    label: "Tag",
    type: "tags",
    parameter: Expression.parse("Tags"),
    unsortable: true,
    raw: {},
  },
];

function getSortable(p: Expression): Path | null {
  const expressionParams = extractPaths(p);
  if (expressionParams.length === 1) return expressionParams[0];
  return null;
}

function getDownloadUrl(
  filter: Expression,
  indexParameters: { label: string; parameter: Expression }[],
): string {
  const columns: Record<string, string> = {};
  for (const p of indexParameters) columns[p.label] = p.parameter.toString();
  return `/api/devices.csv?${new URLSearchParams({
    filter: filter.toString(),
    columns: JSON.stringify(columns),
  }).toString()}`;
}

function unpackSmartQuery(query: Expression): Expression {
  return query.evaluate((e) => {
    if (e instanceof Expression.FunctionCall) {
      if (e.name === "Q") {
        if (
          e.args[0] instanceof Expression.Literal &&
          e.args[1] instanceof Expression.Literal
        ) {
          return smartQuery.unpack(
            "devices",
            e.args[0].value as string,
            e.args[1].value as string,
          );
        }
      }
    }
    return e;
  });
}

export function init(args: URLSearchParams): Promise<Attrs> {
  if (!window.authorizer.hasAccess("devices", 2)) {
    return Promise.reject(
      new Error("You are not authorized to view this page"),
    );
  }
  const filterStr = args.get("filter");
  const sortStr = args.get("sort");
  return Promise.resolve({
    filter: filterStr ? Expression.parse(filterStr) : undefined,
    sort: sortStr ? JSON.parse(sortStr) : undefined,
    indexParameters: CUSTOM_COLUMNS,
  });
}

function renderActions(selected: Set<string>): Node[] {
  const buttons: Node[] = [];

  buttons.push(
    button(
      {
        class:
          "px-4 py-2 border border-stone-300 shadow-xs text-sm font-medium rounded-md text-stone-700 bg-white hover:bg-stone-50 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed",
        title: "Reboot selected devices",
        disabled: !selected.size,
        onclick: () => {
          const tasks = [...selected].map((s) => ({
            name: "reboot",
            device: s,
          }));
          queueTask(...tasks);
        },
      },
      "Reboot",
    ),
  );

  buttons.push(
    button(
      {
        class:
          "px-4 py-2 border border-stone-300 shadow-xs text-sm font-medium rounded-md text-stone-700 bg-white hover:bg-stone-50 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed",
        title: "Factory reset selected devices",
        disabled: !selected.size,
        onclick: () => {
          const tasks = [...selected].map((s) => ({
            name: "factoryReset",
            device: s,
          }));
          queueTask(...tasks);
        },
      },
      "Reset",
    ),
  );

  buttons.push(
    button(
      {
        class:
          "px-4 py-2 border border-stone-300 shadow-xs text-sm font-medium rounded-md text-stone-700 bg-white hover:bg-stone-50 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed",
        title: "Push a firmware or a config file",
        disabled: !selected.size,
        onclick: () => {
          stageDownload({
            name: "download",
            devices: [...selected],
          });
        },
      },
      "Push file",
    ),
  );

  buttons.push(
    button(
      {
        class:
          "px-4 py-2 border border-stone-300 shadow-xs text-sm font-medium rounded-md text-stone-700 bg-white hover:bg-stone-50 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed",
        title: "Delete selected devices",
        disabled: !selected.size,
        onclick: () => {
          const ids = Array.from(selected);
          if (!confirm(`Deleting ${ids.length} devices. Are you sure?`)) return;

          const tasks = ids.map((id) =>
            deleteResource("devices", id)
              .then(() => notifications.push("success", `${id}: Deleted`))
              .catch((err) =>
                notifications.push("error", `${id}: ${err.message}`),
              ),
          );
          void Promise.allSettled(tasks).then(() => {
            store.setTimestamp(Date.now());
            invalidate(Date.now());
          });
        },
      },
      "Delete",
    ),
  );

  buttons.push(
    button(
      {
        class:
          "px-4 py-2 border border-stone-300 shadow-xs text-sm font-medium rounded-md text-stone-700 bg-white hover:bg-stone-50 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed",
        title: "Tag selected devices",
        disabled: !selected.size,
        onclick: () => {
          const ids = Array.from(selected);
          const tag = prompt(`Enter tag to assign to ${ids.length} devices:`);
          if (!tag) return;

          const tasks = ids.map((id) =>
            updateTags(id, { [tag]: true })
              .then(() => notifications.push("success", `${id}: Tags updated`))
              .catch((err) =>
                notifications.push("error", `${id}: ${err.message}`),
              ),
          );
          void Promise.allSettled(tasks).then(() => {
            store.setTimestamp(Date.now());
            invalidate(Date.now());
          });
        },
      },
      "Tag",
    ),
  );

  buttons.push(
    button(
      {
        class:
          "px-4 py-2 border border-stone-300 shadow-xs text-sm font-medium rounded-md text-stone-700 bg-white hover:bg-stone-50 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed",
        title: "Untag selected devices",
        disabled: !selected.size,
        onclick: () => {
          const ids = Array.from(selected);
          const tag = prompt(
            `Enter tag to unassign from ${ids.length} devices:`,
          );
          if (!tag) return;

          const tasks = ids.map((id) =>
            updateTags(id, { [tag]: false })
              .then(() => notifications.push("success", `${id}: Tags updated`))
              .catch((err) =>
                notifications.push("error", `${id}: ${err.message}`),
              ),
          );
          void Promise.allSettled(tasks).then(() => {
            store.setTimestamp(Date.now());
            invalidate(Date.now());
          });
        },
      },
      "Untag",
    ),
  );

  return buttons;
}

export interface Attrs {
  indexParameters: (typeof CUSTOM_COLUMNS)[number][];
  filter?: Expression;
  sort?: Record<string, number>;
}

export function createPage(attrs: Attrs): HTMLElement {
  document.title = "Devices - GenieACS";

  const currentPage = new StateSignal(1);

  const attributes = attrs.indexParameters;
  const sort = attrs.sort || {};

  const filter = unpackSmartQuery(attrs.filter ?? new Expression.Literal(true));

  // Reactive data signals — the device list is page-bounded using
  // bookmark-based pagination (first N items = bookmark, skip via applySkip)
  function devsQuery(): { value: unknown[]; loading: boolean } {
    const page = currentPage.get();
    const offset = (page - 1) * PAGE_SIZE;

    // Page 1: plain pagedFetch with limit = PAGE_SIZE
    if (offset === 0) {
      return pagedFetch("devices", filter, { sort, limit: PAGE_SIZE });
    }

    // Page N: create a bookmark for the first `offset` items to get a
    // row-boundary, then use applySkip to fetch items after that boundary
    const bm = createBookmark("devices", filter, sort, offset);
    const bmState = bm.get();

    if (bmState.timestamp === 0) {
      // Bookmark not yet resolved — loading
      return { value: [], loading: true };
    }

    // Use the bookmark to skip items before it
    const effective = bmState.value
      ? bmState.value.applySkip(filter)
      : filter;
    return pagedFetch("devices", effective, {
      sort,
      limit: PAGE_SIZE,
    });
  }

  const countQuery = reactiveCount("devices", filter);

  // Compute total pages from count
  function totalPages(): number | undefined {
    const t = countQuery.get();
    if (t == null || !t.value) return undefined;
    return Math.ceil(t.value / PAGE_SIZE);
  }

  const downloadUrl = getDownloadUrl(filter, attributes);

  const sortAttributes: Record<number, number> = {};
  for (let i = 0; i < attributes.length; i++) {
    const attr = attributes[i];
    if (attr.unsortable) continue;
    const param = getSortable(attr.parameter);
    if (param) sortAttributes[i] = sort[param.toString()] || 0;
  }

  function onFilterChanged(f: Expression): void {
    const ops: Record<string, string> = {};
    if (!(f instanceof Expression.Literal && f.value))
      ops["filter"] = f.toString();
    if (attrs.sort) ops["sort"] = JSON.stringify(attrs.sort);
    void navigate("/devices", ops);
  }

  function onSortChange(sortedAttrs: number[]): void {
    const _sort: Record<string, number> = {};
    for (const index of sortedAttrs) {
      const param = getSortable(attributes[Math.abs(index) - 1].parameter);
      if (param) _sort[param.toString()] = Math.sign(index);
    }
    const ops: Record<string, string> = { sort: JSON.stringify(_sort) };
    if (attrs.filter) ops["filter"] = attrs.filter.toString();
    void navigate("/devices", ops);
  }

  // Helper: extract a parameter value from a flat device object
  // (GenieACS stores it directly or as {value: [actual]})
  function paramValue(device: any, path: string): unknown {
    const v = device[path];
    if (v != null && typeof v === "object" && "value" in (v as any)) {
      return (v as any).value?.[0];
    }
    return v;
  }

  // Value callback — renders content into a DOM container
  const valueCallback = (attr: any, device: any): Node => {
    // RX — coalesce across vendor paths
    if (attr.label === "RX") {
      const val =
        paramValue(
          device,
          "InternetGatewayDevice.DeviceInfo.X_TP_RxPower",
        ) ??
        paramValue(
          device,
          "InternetGatewayDevice.DeviceInfo.X_HW_RxPower",
        ) ??
        paramValue(
          device,
          "InternetGatewayDevice.DeviceInfo.X_ZTE_RxPower",
        );
      return span({}, val != null ? `${val}` : "");
    }

    // Temp — coalesce across vendor paths
    if (attr.label === "Temp") {
      const val =
        paramValue(
          device,
          "InternetGatewayDevice.DeviceInfo.X_TP_Temperature",
        ) ??
        paramValue(
          device,
          "InternetGatewayDevice.DeviceInfo.X_HW_Temperature",
        ) ??
        paramValue(
          device,
          "InternetGatewayDevice.DeviceInfo.X_ZTE_Temperature",
        );
      return span({}, val != null ? `${val}` : "");
    }

    if (!attr.type && !attr.components && attr.component) {
      return div(
        {},
        renderView(attr.component, {
          ...attr,
          deviceId: device["DeviceID.ID"],
        }),
      );
    }
    return createMithrilHost(() => {
      return mContext.context(
        { device: device, parameter: attr.parameter },
        attr.type || "parameter",
        attr.raw,
      );
    });
  };

  // Record actions callback returns DOM node
  const recordActionsCallback = (device: any): Node[] => {
    return [
      a(
        {
          class: "text-cyan-700 hover:text-cyan-900",
          href: `/devices/${encodeURIComponent(device["DeviceID.ID"])}`,
        },
        "Show",
      ),
    ];
  };

  // Build DOM once — table updates itself via signals
  return div(
    {},
    h1({ class: "text-xl font-medium text-stone-900 mb-5" }, "Listing devices"),
    createFilter({
      resource: "devices",
      filter: attrs.filter,
      onChange: onFilterChanged,
    }),
    createIndexTable({
      attributes: attributes.map((attr) => ({
        ...attr,
        label: attr.label,
        type: attr.type,
      })),
      data: () => devsQuery().value as Record<string, unknown>[],
      total: () => countQuery.get().value,
      loading: () => devsQuery().loading,
      pagination: () => ({
        currentPage: currentPage.get(),
        totalPages: totalPages() ?? 1,
        onPageChange: (page: number) => currentPage.set(page),
      }),
      sortAttributes,
      onSortChange,
      downloadUrl,
      valueCallback,
      recordActionsCallback,
      actionsCallback: window.authorizer.hasAccess("devices", 3)
        ? renderActions
        : undefined,
    }),
  );
}
