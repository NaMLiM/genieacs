// Router that delegates to the appropriate data model-specific device page.
//
// Automatically detects device data model (TR-098 or TR-181) and renders
// the corresponding device page component.
//
// Attributes:
//   deviceId - Device identifier string

const deviceId = node.attributes.deviceId.get();
const deviceResult = new Signal.State(null);
const device = new Signal.Computed(() => deviceResult.get()?.[0]);

const dataModel = new Signal.Computed(() => {
  const dev = device.get();
  if (dev?.["Device:object"]) return "tr181";
  if (dev?.["InternetGatewayDevice:object"]) return "tr098";
  return null;
});

const page = new Signal.Computed(() => {
  const dm = dataModel.get();
  if (dm === "tr181") return <device-page-tr181 device={device} />;
  if (dm === "tr098") return <device-page-tr098 device={device} />;
  return null;
});

// @ts-expect-error: top-level return (script is wrapped in a function at runtime)
return (
  <>
    <do-fetch
      arg={{ resource: "devices", filter: `DeviceID.ID = "${deviceId}"` }}
      res={deviceResult}
    />
    {page}
  </>
);
