import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Standalone, root-owned helper for the tested H616 PHY1 port only.
export async function recoverUsb(
  sysfs = "/sys",
  signal?: AbortSignal,
): Promise<boolean> {
  const read = async (path: string) => {
    try {
      return (await readFile(join(sysfs, path), "utf8")).trim();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return "";
      throw error;
    }
  };
  if (
    !(await read("firmware/devicetree/base/compatible")).includes(
      "allwinner,sun50i-h616",
    )
  )
    return false;
  const usb = "bus/usb/devices";
  const rootBus = async (controller: string) => {
    const root = (
      await readdir(join(sysfs, "bus/platform/devices", controller))
    ).find((name) => /^usb\d+$/.test(name));
    if (!root || (await read(`${usb}/${root}/serial`)) !== controller)
      throw new Error(`USB root does not match ${controller}`);
    return root;
  };
  const ehci = await rootBus("5200000.usb");
  const ohci = await rootBus("5200400.usb");
  const highPort = `${ehci.slice(3)}-1`;
  const lowPort = `${ohci.slice(3)}-1`;
  const eligible = async () => {
    if (
      (await read(`${usb}/${highPort}/speed`)) === "480" ||
      (await read(`${usb}/${lowPort}/speed`)) !== "12"
    )
      return false;
    const branch = (await readdir(join(sysfs, usb))).filter(
      (name) =>
        name === lowPort ||
        (name.startsWith(`${lowPort}.`) && !name.includes(":")),
    );
    for (const name of branch) {
      const id = `${await read(`${usb}/${name}/idVendor`)}:${await read(`${usb}/${name}/idProduct`)}`;
      if (name === lowPort && id === "05e3:0610") continue;
      // Other peripherals, including all storage, must not be interrupted.
      if (id !== "0bda:2838" && id !== "0bda:2832") return false;
    }
    return true;
  };
  if (!(await eligible())) return false;
  const companion = join(sysfs, "bus/platform/devices/5200000.usb/companion");
  const policy = join(sysfs, `${usb}/${ehci}/power/control`);
  const original = await readFile(policy, "utf8");
  // Do not change a deliberately configured companion assignment.
  if ((await readFile(companion, "utf8")).trim()) return false;
  signal?.throwIfAborted();
  try {
    await writeFile(policy, "on\n");
    signal?.throwIfAborted();
    if (!(await eligible())) return false;
    signal?.throwIfAborted();
    await writeFile(companion, "-1\n");
    return true;
  } finally {
    await writeFile(policy, original);
  }
}

if (import.meta.main) {
  if (process.argv.length !== 2)
    throw new Error("USB recovery takes no arguments");
  const stopping = new AbortController();
  process.once("SIGTERM", () => stopping.abort());
  process.once("SIGINT", () => stopping.abort());
  const signal = AbortSignal.any([stopping.signal, AbortSignal.timeout(5_000)]);
  if (await recoverUsb("/sys", signal))
    console.log("Requested PHY1 high-speed USB recovery");
}
