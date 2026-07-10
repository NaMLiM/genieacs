// Upload panel for a device: lists files uploaded from the device, with
// controls to request a new upload from the device or delete an
// already-uploaded file. Presentation-agnostic — the caller decides whether to
// render it inline in the page or wrapped in an overlay-dialog.
//
// Attributes:
//   device - Device object from the parent view

const device = node.attributes.device;
const deviceId = new Signal.Computed(() => device.get()?.["DeviceID.ID"]);
const taskCmd = new Signal.State(null);
const delCmd = new Signal.State(null);
const delStatus = new Signal.State(null);
const deviceUploads = new Signal.State(null);
const refreshTime = new Signal.State(0);

const delMessage = new Signal.Computed(() => {
  const s = delStatus.get();
  if (s === true) return { type: "success", message: "Deleted successfully" };
  if (s instanceof Error) return { type: "error", message: s.message };
  return null;
});

const uploadParams = new Signal.Computed(() => {
  const uploads = {};

  for (const [key, value] of Object.entries(device.get() ?? {})) {
    if (!key.startsWith("Uploads.") || key.includes(":")) continue;
    const parts = key.split(".");
    if (parts.length !== 3) continue;
    uploads[parts[1]] = uploads[parts[1]] || {};
    uploads[parts[1]][parts[2]] = value;
  }

  return Object.values(uploads)
    .filter((u) => u["Upload"])
    .sort((a, b) => a["Upload"] - b["Upload"]);
});

const hasPending = new Signal.Computed(() =>
  uploadParams.get().some((u) => !(u["LastUpload"] >= u["Upload"])),
);

const poll = new Signal.Computed(() => {
  if (!hasPending.get()) return null;
  setInterval(() => refreshTime.set(Date.now()), 10000);
  return null;
});

const uploadsQuery = new Signal.Computed(() => ({
  resource: "uploads",
  filter: `_id > '${deviceId.get()}/' AND _id < '${deviceId.get()}/\xff'`,
  freshness: refreshTime.get(),
}));

const deviceQuery = new Signal.Computed(() => ({
  resource: "devices",
  filter: `DeviceID.ID = "${deviceId.get()}"`,
  freshness: refreshTime.get(),
}));

const uploadRows = new Signal.Computed(() => {
  const stored = new Set((deviceUploads.get() || []).map((f) => f._id));

  const render = [];
  for (const u of uploadParams.get()) {
    const filePath = `${deviceId.get()}/${u["FileName"]}`;
    const ready = u?.["LastUpload"] >= u?.["Upload"];
    if (ready && !stored.has(filePath)) {
      continue;
    }
    render.push(
      Object.assign({}, u, {
        status: ready ? "Ready" : "Waiting for Upload",
      }),
    );
  }
  if (render.length === 0) {
    return (
      <tr>
        <td
          class="bg-stripes text-sm font-medium text-center text-stone-500 p-4"
          colspan={5}
        >
          No Uploads
        </td>
      </tr>
    );
  }
  return render.map((u) => {
    const filePath = `${deviceId.get()}/${u["FileName"]}`;

    return (
      <tr>
        <td class="whitespace-nowrap py-4 text-sm text-stone-900 pl-6 pr-3">
          {u["FileName"]}
        </td>
        <td class="whitespace-nowrap py-4 text-sm text-stone-900 px-3">
          {u["FileType"]}
        </td>
        <td class="whitespace-nowrap py-4 text-sm text-stone-900 px-3">
          {new Date(
            u.status === "Ready" ? u["LastUpload"] : u["Upload"],
          ).toLocaleString()}
        </td>
        {u.status === "Ready" ? (
          <td class="whitespace-nowrap py-4 text-sm px-3">
            <a
              href={`/api/uploads/blob/${encodeURIComponent(filePath)}`}
              class="text-cyan-600 hover:text-cyan-900 font-medium"
            >
              Ready
            </a>
          </td>
        ) : (
          <td class="whitespace-nowrap py-4 text-sm text-stone-900 px-3">
            Waiting for Upload
          </td>
        )}
        <td class="whitespace-nowrap pl-3 pr-6 py-4">
          {u.status === "Ready" && (
            <button
              onclick={() => {
                delStatus.set(null);
                delCmd.set({ resource: "uploads", id: filePath });
              }}
              title="Delete file"
            >
              <icon
                name="delete-instance"
                class="inline h-4 w-4 ml-1 text-cyan-700 hover:text-cyan-900"
              />
            </button>
          )}
        </td>
      </tr>
    );
  });
});

// @ts-expect-error: top-level return (script is wrapped in a function at runtime)
return (
  <>
    <do-task arg={taskCmd} />
    <do-delete arg={delCmd} res={delStatus} />
    <do-notify arg={delMessage} />
    <do-fetch arg={uploadsQuery} res={deviceUploads} />
    <do-fetch arg={deviceQuery} />
    {poll}
    <div class="shadow overflow-hidden rounded-lg">
      <table class="divide-y divide-stone-200 w-full">
        <thead class="bg-stone-50">
          <tr>
            {["Filename", "Type", "Timestamp", "Status"].map((label, i) => (
              <th
                class={`py-3.5 text-left text-sm font-semibold text-stone-500 ${i ? "px-3" : "pl-6 pr-3"}`}
              >
                {label}
              </th>
            ))}
            <th class="pl-3" />
          </tr>
        </thead>
        <tbody class="bg-white divide-y divide-stone-200">
          {uploadRows}
          <tr>
            <td class="whitespace-nowrap pl-3 pr-6 py-4 text-sm" colspan={5}>
              <button
                onclick={() =>
                  taskCmd.set({ name: "upload", devices: [deviceId.get()] })
                }
                title="Fetch a new file from device"
              >
                <icon
                  name="add-instance"
                  class="inline h-4 w-4 ml-1 text-cyan-700 hover:text-cyan-900"
                />
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </>
);
