import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { recoverUsb } from "./recover-usb";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "subpager-usb-"));
  for (const [path, value] of Object.entries({
    "firmware/devicetree/base/compatible": "allwinner,sun50i-h616\0",
    "bus/usb/devices/4-1/speed": "12\n",
    "bus/usb/devices/4-1/idVendor": "05e3\n",
    "bus/usb/devices/4-1/idProduct": "0610\n",
    "bus/usb/devices/4-1.2/idVendor": "0bda\n",
    "bus/usb/devices/4-1.2/idProduct": "2838\n",
    "bus/usb/devices/usb2/power/control": "auto\n",
    "bus/usb/devices/usb2/serial": "5200000.usb\n",
    "bus/usb/devices/usb4/serial": "5200400.usb\n",
    "bus/platform/devices/5200000.usb/companion": "",
  })) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), value);
  }
  await mkdir(join(root, "bus/platform/devices/5200000.usb/usb2"));
  await mkdir(join(root, "bus/platform/devices/5200400.usb/usb4"), {
    recursive: true,
  });
  return root;
}

test("PHY1 fallback requests ownership recovery and restores power policy", async () => {
  const root = await fixture();
  try {
    expect(await recoverUsb(root)).toBe(true);
    expect(
      await readFile(
        join(root, "bus/platform/devices/5200000.usb/companion"),
        "utf8",
      ),
    ).toBe("-1\n");
    expect(
      await readFile(join(root, "bus/usb/devices/usb2/power/control"), "utf8"),
    ).toBe("auto\n");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("recovery follows PHY1 controllers when USB bus numbers change", async () => {
  const root = await fixture();
  try {
    for (const [from, to] of [
      ["bus/usb/devices/usb2", "bus/usb/devices/usb9"],
      ["bus/usb/devices/usb4", "bus/usb/devices/usb7"],
      [
        "bus/platform/devices/5200000.usb/usb2",
        "bus/platform/devices/5200000.usb/usb9",
      ],
      [
        "bus/platform/devices/5200400.usb/usb4",
        "bus/platform/devices/5200400.usb/usb7",
      ],
      ["bus/usb/devices/4-1", "bus/usb/devices/7-1"],
      ["bus/usb/devices/4-1.2", "bus/usb/devices/7-1.2"],
    ])
      await rename(join(root, from!), join(root, to!));
    expect(await recoverUsb(root)).toBe(true);
    expect(
      await readFile(join(root, "bus/usb/devices/usb9/power/control"), "utf8"),
    ).toBe("auto\n");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a dedicated empty hub can recover before the SDR enumerates", async () => {
  const root = await fixture();
  try {
    await rm(join(root, "bus/usb/devices/4-1.2"), { recursive: true });
    expect(await recoverUsb(root)).toBe(true);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("cancellation after waking EHCI restores power without requesting ownership", async () => {
  const root = await fixture();
  const abort = new AbortController();
  const check = abort.signal.throwIfAborted.bind(abort.signal);
  const policy = join(root, "bus/usb/devices/usb2/power/control");
  const intercepted = spyOn(abort.signal, "throwIfAborted").mockImplementation(
    () => {
      if (readFileSync(policy, "utf8").trim() === "on") abort.abort();
      check();
    },
  );
  try {
    await expect(recoverUsb(root, abort.signal)).rejects.toThrow();
    expect(await readFile(policy, "utf8")).toBe("auto\n");
    expect(
      await readFile(
        join(root, "bus/platform/devices/5200000.usb/companion"),
        "utf8",
      ),
    ).toBe("");
  } finally {
    intercepted.mockRestore();
    await rm(root, { recursive: true });
  }
});

for (const scenario of [
  "healthy",
  "storage",
  "missing",
  "other-board",
  "dedicated",
  "wrong-controller",
] as const) {
  test(`USB recovery skips ${scenario} without changing controller settings`, async () => {
    const root = await fixture();
    const companion = join(root, "bus/platform/devices/5200000.usb/companion");
    try {
      if (scenario === "healthy") {
        await mkdir(join(root, "bus/usb/devices/2-1"));
        await writeFile(join(root, "bus/usb/devices/2-1/speed"), "480\n");
      } else if (scenario === "storage") {
        await writeFile(join(root, "bus/usb/devices/4-1.2/idVendor"), "0781\n");
        await writeFile(
          join(root, "bus/usb/devices/4-1.2/idProduct"),
          "5595\n",
        );
      } else if (scenario === "missing") {
        await rm(join(root, "bus/usb/devices/4-1"), { recursive: true });
      } else if (scenario === "other-board") {
        await writeFile(
          join(root, "firmware/devicetree/base/compatible"),
          "another-board\0",
        );
      } else if (scenario === "wrong-controller") {
        await writeFile(
          join(root, "bus/usb/devices/usb2/serial"),
          "5101000.usb\n",
        );
      } else {
        await writeFile(companion, "1\n");
      }
      if (scenario === "wrong-controller")
        await expect(recoverUsb(root)).rejects.toThrow(
          "USB root does not match",
        );
      else expect(await recoverUsb(root)).toBe(false);
      expect(await readFile(companion, "utf8")).toBe(
        scenario === "dedicated" ? "1\n" : "",
      );
      expect(
        await readFile(
          join(root, "bus/usb/devices/usb2/power/control"),
          "utf8",
        ),
      ).toBe("auto\n");
    } finally {
      await rm(root, { recursive: true });
    }
  });
}

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "failed ownership write restores the original power policy",
  async () => {
    const root = await fixture();
    try {
      await chmod(
        join(root, "bus/platform/devices/5200000.usb/companion"),
        0o444,
      );
      await expect(recoverUsb(root)).rejects.toThrow();
      expect(
        await readFile(
          join(root, "bus/usb/devices/usb2/power/control"),
          "utf8",
        ),
      ).toBe("auto\n");
    } finally {
      await rm(root, { recursive: true });
    }
  },
);

test("cancelled recovery does not change controller settings", async () => {
  const root = await fixture();
  try {
    await expect(recoverUsb(root, AbortSignal.abort())).rejects.toThrow();
    expect(
      await readFile(
        join(root, "bus/platform/devices/5200000.usb/companion"),
        "utf8",
      ),
    ).toBe("");
    expect(
      await readFile(join(root, "bus/usb/devices/usb2/power/control"), "utf8"),
    ).toBe("auto\n");
  } finally {
    await rm(root, { recursive: true });
  }
});
