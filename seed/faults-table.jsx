// Faults table for a device, with a detail overlay for fault YAML output.
//
// Fetches the device's faults, renders them in a table, and lets the user
// delete individual faults or expand the YAML-stringified detail in a modal
// overlay.
//
// Attributes:
//   device - Device object from the parent view

const device = node.attributes.device.get();
const deviceId = device["DeviceID.ID"];
const deviceFaults = new Signal.State(null);
const delCmd = new Signal.State(null);
const delStatus = new Signal.State(null);
const overlayOpen = new Signal.State(false);
const overlayYaml = new Signal.State("");

const delMessage = new Signal.Computed(() => {
  const s = delStatus.get();
  if (s === true) return { type: "success", message: "Deleted successfully" };
  if (s instanceof Error) return { type: "error", message: s.message };
  return null;
});

const faultsTable = new Signal.Computed(() => {
  const faults = deviceFaults.get();
  if (!faults?.length)
    return (
      <tr>
        <td
          class="bg-stripes text-sm font-medium text-center text-stone-500 p-4"
          colspan="7"
        >
          No faults
        </td>
      </tr>
    );
  return faults.map((f) => {
    const yamlOut = new Signal.State("");
    const openDetail = () => {
      overlayYaml.set(yamlOut.get());
      overlayOpen.set(true);
    };
    return (
      <tr key={f._id}>
        <td class="whitespace-nowrap pl-6 pr-3 py-4 text-sm text-stone-900">
          {f.channel}
        </td>
        <td class="whitespace-nowrap px-3 py-4 text-sm text-stone-900">
          {f.code}
        </td>
        <td class="whitespace-nowrap px-3 py-4 text-sm text-stone-900">
          <span
            class="inline-block truncate decoration-dotted max-w-xs"
            onmouseover={(e) => {
              e.target.title = f.message;
            }}
          >
            {f.message}
          </span>
        </td>
        <td class="whitespace-nowrap px-3 py-4 text-sm text-stone-900">
          <do-yaml-stringify arg={f.detail} res={yamlOut} />
          <span
            class="inline-block truncate decoration-dotted max-w-xs cursor-pointer hover:underline"
            role="button"
            tabindex="0"
            aria-haspopup="dialog"
            onmouseover={(e) => {
              e.target.title = e.target.textContent;
            }}
            onclick={openDetail}
            onkeydown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openDetail();
              }
            }}
          >
            {yamlOut}
          </span>
        </td>
        <td class="whitespace-nowrap px-3 py-4 text-sm text-stone-900">
          {f.retries}
        </td>
        <td class="whitespace-nowrap px-3 py-4 text-sm text-stone-900">
          {new Date(f.timestamp).toLocaleString()}
        </td>
        <td class="whitespace-nowrap px-3 py-4 text-sm text-stone-900">
          <button
            class="text-cyan-700 hover:text-cyan-900 font-medium"
            onclick={() => {
              delStatus.set(null);
              delCmd.set({ resource: "faults", id: f._id });
            }}
          >
            Delete
          </button>
        </td>
      </tr>
    );
  });
});

// @ts-expect-error: top-level return (script is wrapped in a function at runtime)
return (
  <>
    <do-delete arg={delCmd} res={delStatus} />
    <do-notify arg={delMessage} />
    <do-fetch
      arg={{
        resource: "faults",
        filter: `_id > '${deviceId}:' AND _id < '${deviceId}:\xff'`,
      }}
      res={deviceFaults}
    />
    <div class="shadow overflow-hidden rounded-lg w-max">
      <table class="divide-y divide-stone-200">
        <thead class="bg-stone-50">
          <tr>
            <th class="py-3.5 text-left text-sm font-semibold text-stone-500 pl-6 pr-3">
              Channel
            </th>
            <th class="py-3.5 text-left text-sm font-semibold text-stone-500 px-3">
              Code
            </th>
            <th class="py-3.5 text-left text-sm font-semibold text-stone-500 px-3">
              Message
            </th>
            <th class="py-3.5 text-left text-sm font-semibold text-stone-500 px-3">
              Detail
            </th>
            <th class="py-3.5 text-left text-sm font-semibold text-stone-500 px-3">
              Retries
            </th>
            <th class="py-3.5 text-left text-sm font-semibold text-stone-500 px-3">
              Timestamp
            </th>
            <th class="py-3.5 text-left text-sm font-semibold text-stone-500 px-3"></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-stone-200 bg-white">{faultsTable}</tbody>
      </table>
    </div>
    <overlay-dialog open={overlayOpen}>
      <textarea
        class="font-mono text-sm focus:ring-cyan-500 focus:border-cyan-500 border border-stone-300 rounded-md"
        cols="80"
        rows="24"
        readonly={true}
        value={overlayYaml}
      />
    </overlay-dialog>
  </>
);
