// Device page for TR-098 (InternetGatewayDevice) data model.
//
// Displays device information, parameters, LAN hosts, faults, and data model.
// Customize the 'parameters' array below to change displayed fields.
//
// Attributes:
//   device - Device object from the parent router

const device = node.attributes.device;
const deviceId = new Signal.Computed(() => device.get()?.["DeviceID.ID"]);
const taskCmd = new Signal.State(null);
const delCmd = new Signal.State(null);
const delStatus = new Signal.State(null);
const uploadsOpen = new Signal.State(false);

const delMessage = new Signal.Computed(() => {
  const s = delStatus.get();
  if (s === true) return { type: "success", message: "Deleted successfully" };
  if (s instanceof Error) return { type: "error", message: s.message };
  return null;
});

const pingResult = new Signal.State(null);
const pingDisplay = new Signal.Computed(() => {
  const r = pingResult.get();
  if (r == null) return null;
  if (r instanceof Error) return "Error!";
  if (typeof r === "number") return `${Math.trunc(r)} ms`;
  return "Unreachable";
});

const hostIp = new Signal.Computed(() => {
  const connectionUrl =
    device.get()?.[
      "InternetGatewayDevice.ManagementServer.ConnectionRequestURL"
    ];
  return connectionUrl ? new URL(connectionUrl).hostname : null;
});

// Device parameters to display
const parameters = [
  { label: "Serial number", param: "DeviceID.SerialNumber" },
  { label: "Product class", param: "DeviceID.ProductClass" },
  { label: "OUI", param: "DeviceID.OUI" },
  { label: "Manufacturer", param: "DeviceID.Manufacturer" },
  {
    label: "Hardware version",
    param: "InternetGatewayDevice.DeviceInfo.HardwareVersion",
  },
  {
    label: "Software version",
    param: "InternetGatewayDevice.DeviceInfo.SoftwareVersion",
  },
  {
    label: "MAC",
    param:
      "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.MACAddress",
  },
  {
    label: "IP",
    param:
      "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress",
  },
  {
    label: "WLAN SSID",
    param: "InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID",
  },
  {
    label: "WLAN passphrase",
    param:
      "InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase",
  },
];

const hostsRoot = "InternetGatewayDevice.LANDevice.1.Hosts.Host";
const hostsColumns = [
  { label: "Host name", param: "HostName" },
  { label: "IP", param: "IPAddress" },
  { label: "MAC", param: "MACAddress" },
];

// Parameters to refresh when summoning the device
const summonParams = [
  ...parameters.map((p) => p.param).filter((p) => !p.startsWith("DeviceID.")),
  ...hostsColumns.map((c) => `${hostsRoot}.*.${c.param}`),
];

const parameterRows = new Signal.Computed(() => {
  const dev = device.get() ?? {};
  return parameters
    .filter(({ param }) => dev[param])
    .map(({ label, param }) => (
      <tr class="border-b border-stone-200">
        <th class="text-sm font-medium text-stone-500 text-left px-6 py-3">
          {label}
        </th>
        <td class="text-sm text-stone-900 px-6 py-3">
          <parameter device={device} param={param} />
        </td>
      </tr>
    ));
});

const FIVE_MINUTES = 5 * 60 * 1000;
const ONE_DAY = 24 * 60 * 60 * 1000;

const onlineStatus = new Signal.Computed(() => {
  const informTime = device.get()?.["Events.Inform"];
  const now = Date.now();
  if (informTime > now - FIVE_MINUTES) return "Online";
  if (informTime > now - FIVE_MINUTES - ONE_DAY) return "Past 24 Hours";
  return "Others";
});

const statusColor = new Signal.Computed(
  () =>
    ({ Online: "#31a354", "Past 24 Hours": "#a1d99b" })[onlineStatus.get()] ??
    "#e5f5e0",
);

// @ts-expect-error: top-level return (script is wrapped in a function at runtime)
return (
  <>
    <do-task arg={taskCmd} />
    <do-delete arg={delCmd} res={delStatus} />
    <do-notify arg={delMessage} />
    <div class="device-page">
      <h1>{deviceId}</h1>
      <tags device={device} writable={true} />
      <do-ping arg={hostIp} res={pingResult} />
      <div class="text-sm my-4 px-1">
        <span class="font-medium text-stone-500">Pinging {hostIp}: </span>
        {pingDisplay}
      </div>
      <table class="table-auto bg-white shadow rounded-lg divide-y divide-stone-200 w-max">
        <tbody>
          <tr class="border-b border-stone-200">
            <th class="text-sm font-medium text-stone-500 text-left px-6 py-3">
              Last inform
            </th>
            <td class="text-sm text-stone-900 px-6 py-3">
              <span class="inform">
                <parameter device={device} param="Events.Inform" />
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  class="inline"
                  width="1em"
                  height="1em"
                  style="margin: 0 0.2em 0.2em"
                >
                  <circle
                    class="stroke-stone-200 stroke-1"
                    cx="0.5em"
                    cy="0.5em"
                    r="0.4em"
                    fill={statusColor}
                  />
                </svg>
                {onlineStatus}
                <summon-button deviceId={deviceId} params={summonParams} />
              </span>
            </td>
          </tr>
          {parameterRows}
        </tbody>
      </table>
      <h2>LAN Hosts</h2>
      <instance-table root={hostsRoot} device={device}>
        {hostsColumns.map((c) => (
          <param label={c.label} param={c.param} />
        ))}
      </instance-table>
      <h2>Faults</h2>
      <faults-table device={device} />
      <h2>Data model</h2>
      <datamodel-explorer device={device} />
      <div class="space-x-3 mt-4">
        {[
          {
            label: "Reboot",
            title: "Reboot device",
            action: () =>
              taskCmd.set({ name: "reboot", device: deviceId.get() }),
          },
          {
            label: "Reset",
            title: "Factory reset device",
            action: () =>
              taskCmd.set({ name: "factoryReset", device: deviceId.get() }),
          },
          {
            label: "Push file",
            title: "Push a firmware or config file",
            action: () =>
              taskCmd.set({ name: "download", devices: [deviceId.get()] }),
          },
          {
            label: "Delete",
            title: "Delete device",
            action: () => {
              const id = deviceId.get();
              if (confirm(`Delete device ${id}?`)) {
                delStatus.set(null);
                delCmd.set({ resource: "devices", id });
              }
            },
          },
          {
            label: "Upload",
            title: "Upload a file from the device",
            action: () => uploadsOpen.set(true),
          },
        ].map(({ label, title, action }) => (
          <button
            onclick={action}
            title={title}
            class="px-4 py-2 border border-stone-300 shadow-sm text-sm font-medium rounded-md text-stone-700 bg-white hover:bg-stone-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {label}
          </button>
        ))}
      </div>
    </div>
    <overlay-dialog open={uploadsOpen}>
      <h2 class="text-lg font-medium leading-6 text-stone-900 mb-4 pr-6">
        Uploads from {deviceId}
      </h2>
      <uploads-panel device={device} />
    </overlay-dialog>
  </>
);
