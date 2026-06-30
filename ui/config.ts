import Expression from "../lib/common/expression.ts";
export const configSnapshot = window.configSnapshot;
export const genieacsVersion = window.genieacsVersion;

type Filters = { label: string; parameter: Expression; type: string }[];
type pageSize = number;
type overview = {
  charts: {
    [name: string]: {
      label: string;
      slices: {
        label: string;
        filter: Expression;
        color: string;
      }[];
    };
  };
  groups: {
    label: string;
    charts: string[];
  }[];
};

type Index = {
  label: string;
  type?: string;
  parameter: Expression;
  unsortable: boolean;
  raw: NestedRecord;
}[];

type NestedRecord = { [k: string]: Expression | NestedRecord };

const conf: NestedRecord = {};
for (const [key, value] of Object.entries(window.clientConfig)) {
  const exp = Expression.parse(value).evaluate((e) => e);
  let ref = conf;
  const keyParts = key.split(".");
  while (keyParts.length > 1) {
    const k = keyParts.shift()!;
    if (ref[k] == null || typeof ref[k] !== "object") ref[k] = {};
    ref = ref[k] as NestedRecord;
  }
  ref[keyParts[0]] = exp;
}

export const filters: Filters = [];
export let pageSize: number = 10;
export const overview: overview = {
  charts: {
    online: {
      label: "Online Status",
      slices: [
        {
          label: "Online",
          filter: Expression.parse('Events.Inform > NOW() - 300000'),
          color: "#31a354",
        },
        {
          label: "1 day",
          filter: Expression.parse('Events.Inform > NOW() - 86400000'),
          color: "#a1d99b",
        },
        {
          label: "Offline",
          filter: Expression.parse('Events.Inform <= NOW() - 86400000'),
          color: "#e5f5e0",
        },
      ],
    },
  },
  groups: [],
};
// Index and filters are now hardcoded in devices-page.ts and smart-query.ts
export const index: Index = [];
export let device: NestedRecord = {};

const overviewConf = conf["overview"] as NestedRecord | undefined;
for (const obj of Object.values(
  (overviewConf?.["groups"] as NestedRecord) || {},
) as NestedRecord[]) {
  let label = "";
  const charts: string[] = [];
  if (obj["label"] instanceof Expression.Literal)
    label = obj["label"].value as string;
  for (const chart of Object.values((obj["charts"] as NestedRecord) || {})) {
    if (chart instanceof Expression.Literal) charts.push(chart.value as string);
  }
  overview.groups.push({ label, charts });
}

for (const [name, objRaw] of Object.entries(
  (overviewConf?.["charts"] as NestedRecord) || {},
)) {
  const obj = objRaw as NestedRecord;
  const slices: { label: string; filter: Expression; color: string }[] = [];
  for (const sliceRaw of Object.values((obj["slices"] as NestedRecord) || {})) {
    const slice = sliceRaw as NestedRecord;
    let label = "";
    let filter: Expression = new Expression.Literal(false);
    let color = "";
    if (slice["label"] instanceof Expression.Literal)
      label = slice["label"].value as string;
    if (slice["filter"] instanceof Expression) filter = slice["filter"];
    if (slice["color"] instanceof Expression.Literal)
      color = slice["color"].value as string;
    slices.push({ label, filter, color });
  }
  let label = "";
  if (obj["label"] instanceof Expression.Literal)
    label = obj["label"].value as string;
  overview.charts[name] = { label, slices };
}

if (conf["pageSize"] instanceof Expression.Literal)
  pageSize = +(conf["pageSize"].value as number) || 10;

device = conf["device"] as NestedRecord;

// Raw config values for checking if views are configured
export const rawConf = conf;
