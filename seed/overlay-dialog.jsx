// Modal overlay dialog. Renders its children centered over a dimmed backdrop,
// with a close button and Escape-to-close. Visibility is controlled by the
// caller through the `open` state signal, which the dialog flips to false when
// the user dismisses it.
//
// Attributes:
//   open - Boolean state signal; the dialog is shown while it is true
//
// Children: the dialog body content (mounted only while open).

const open = node.attributes.open;
const children = node.children;

const handleEscape = (e) => {
  // @ts-expect-error: `open` is a caller-owned state signal, but attributes are typed read-only
  if (e.key === "Escape" && open.get()) open.set(false);
};
addEventListener("keydown", handleEscape);

// @ts-expect-error: top-level return (script is wrapped in a function at runtime)
return new Signal.Computed(() => {
  if (!open.get()) return null;
  return (
    <div
      class="fixed z-20 inset-0 overflow-y-auto"
      role="dialog"
      aria-modal="true"
    >
      <div class="flex items-center justify-center min-h-screen p-4 text-center">
        <div class="fixed inset-0 bg-black/50" aria-hidden="true" />
        <div class="relative z-10 bg-stone-100 rounded-lg px-4 pt-5 pb-4 text-left overflow-hidden shadow-xl transform max-w-full ">
          <div class="block absolute top-0 right-0 pt-4 pr-4">
            <button
              type="button"
              class="rounded-md text-stone-400 hover:text-stone-500 focus:outline-2 focus:outline-offset-2 focus:outline-cyan-500"
              onclick={() => open.set(false)}
            >
              <span class="sr-only">Close</span>
              <icon name="close" class="h-6 w-6" />
            </button>
          </div>
          <div>{children}</div>
        </div>
      </div>
    </div>
  );
});
