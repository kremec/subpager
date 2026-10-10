import { beforeEach, expect, mock, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";

import type { SpinEvent } from "@/pager/types";

const react = await import("react");
let expanded = false;
const openedURLs: string[] = [];
mock.module("react", () => ({
  ...react,
  useState: () => [expanded, () => (expanded = !expanded)],
}));
mock.module("react-native", () => ({ Pressable: "Pressable", View: "View" }));
mock.module("expo-linking", () => ({
  openURL: async (url: string) => {
    openedURLs.push(url);
  },
}));
mock.module("@tabler/icons-react-native", () => ({
  IconChevronDown: "IconChevronDown",
  IconChevronUp: "IconChevronUp",
  IconMapPin: "IconMapPin",
}));
mock.module("@/components/ui/toast", () => ({ showErrorToast: () => {} }));
mock.module("@/components/ui/typography", () => ({ Typography: "Typography" }));
mock.module("@/theme/use-theme", () => ({
  useTheme: () => ({
    radius: { sm: 10 },
    spacing: { xs: 4, sm: 8, md: 12 },
    colors: { text: "black", textSecondary: "gray", backgroundElement: "gray" },
  }),
}));

const { SpinReport } = await import("@/pager/spin-report");
interface NodeProps {
  children?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
}
function elements(node: ReactNode): ReactElement<NodeProps>[] {
  return react.Children.toArray(node).flatMap((child) => {
    if (!react.isValidElement<NodeProps>(child)) return [];
    return [child, ...elements(child.props.children)];
  });
}
function text(node: ReactNode): string {
  return react.Children.toArray(node)
    .map((child) => {
      if (react.isValidElement<NodeProps>(child))
        return text(child.props.children);
      return typeof child === "string" || typeof child === "number"
        ? child
        : "";
    })
    .join("");
}
const event: SpinEvent = {
  id: "472584",
  title: "Požar, eksplozija",
  description: "Ljubljana",
  eventAt: "2026-10-10T17:51:26.000Z",
  municipality: "Ljubljana",
  category: "Požari v stanovanjskih stavbah",
  latitude: 46.071,
  longitude: 14.485,
};
function render(report = event) {
  // oxlint-disable-next-line react-hooks/rules-of-hooks -- Inspect native content without a native renderer.
  return SpinReport({ event: report }) as ReactElement<NodeProps>;
}
beforeEach(() => {
  expanded = false;
  openedURLs.length = 0;
});

test("partial matches are static municipality, source links and date rows", () => {
  const row = render();
  expect(text(row)).toContain("Ljubljana");
  expect(text(row)).not.toContain(event.category!);
  expect(text(row)).not.toContain("Possible");
  expect(text(row)).not.toContain("Description pending.");
  expect(elements(row).filter((element) => element.props.onPress)).toHaveLength(
    2,
  );
  expect(
    elements(row).find((element) =>
      element.props.accessibilityLabel?.includes("SPIN report"),
    ),
  ).toBeUndefined();
  expect(
    elements(row).some((element) =>
      String(element.type).startsWith("IconChevron"),
    ),
  ).toBe(false);
});

test("footer links open the exact incident and coordinates without changing disclosure state", () => {
  for (const report of [
    event,
    { ...event, description: "Public narrative." },
  ]) {
    expanded = report.description !== event.description;
    const wasExpanded = expanded;
    const row = render(report);
    const link = elements(row).find((element) =>
      element.props.accessibilityLabel?.endsWith("open SPIN event"),
    );
    expect(link).toBeDefined();
    link!.props.onPress!();
    const map = elements(row).find((element) =>
      element.props.accessibilityLabel?.endsWith("open approximate location"),
    );
    expect(map).toBeDefined();
    map!.props.onPress!();
    expect(expanded).toBe(wasExpanded);
  }
  expect(openedURLs).toEqual([
    "https://spin3.sos112.si/javno/zemljevid/472584",
    "https://www.google.com/maps/search/?api=1&query=46.071,14.485",
    "https://spin3.sos112.si/javno/zemljevid/472584",
    "https://www.google.com/maps/search/?api=1&query=46.071,14.485",
  ]);
});

test("confirmed and legacy links retain the narrative without a provisional label or redundant category", () => {
  expanded = true;
  const confirmed = { ...event, description: "Gasilci so pogasili požar." };
  const content = text(render(confirmed));
  expect(content).toContain(confirmed.description);
  expect(content).not.toContain("Possible");
  expect(content).not.toContain("Description pending.");
  expect(content).not.toContain(event.category!);
});

test("empty and municipality-only descriptions have no body even after a previous expansion", () => {
  expanded = true;
  for (const description of ["", " LJUBLJANA "]) {
    const content = text(render({ ...event, description }));
    expect(content).not.toContain("Description pending.");
    expect(content).not.toContain(" LJUBLJANA ");
    expect(content).not.toContain(event.category!);
  }
});

test("reports gain a working disclosure when a narrative arrives", () => {
  const report = { ...event, description: "Gasilci so pogasili požar." };
  const closed = render(report);
  expect(text(closed)).not.toContain(report.description);
  expect(text(closed)).not.toContain("SPIN");
  expect(
    elements(closed).filter((element) => element.props.onPress),
  ).toHaveLength(1);
  const header = elements(closed).find((element) =>
    element.props.accessibilityLabel?.startsWith("Show SPIN report"),
  );
  expect(header).toBeDefined();
  header!.props.onPress!();
  expect(text(render(report))).toContain(report.description);
  expect(text(render(report))).toContain("SPIN");
  expect(
    elements(render(report)).filter((element) => element.props.onPress),
  ).toHaveLength(3);
});
