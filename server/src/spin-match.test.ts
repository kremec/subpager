import { describe, expect, test } from "bun:test";
import {
  checkSpinDecision,
  requestSpinMatch,
  type SpinDecision,
  type SpinPager,
} from "./spin-match";
import type { SpinEvent } from "./spin-feed";
import type { SpinAddress } from "./spin-geocode";

const pager: SpinPager = {
  content: "IGNIS-GBL: Pozari v objektih Pavsiceva ulica 18",
  receivedAt: "2026-10-10T17:54:34.077Z",
  location: "Pavsiceva ulica 18",
};
const partial: SpinEvent = {
  id: "472584",
  title: "Požar, eksplozija",
  description: "Ljubljana",
  municipality: "Ljubljana",
  category: "Požari v stanovanjskih stavbah",
  eventAt: "2026-10-10T17:51:26.000Z",
  latitude: 46.071,
  longitude: 14.485,
};
const address: SpinAddress = {
  address: "Pavšičeva ulica, 18, Ljubljana",
  latitude: 46.071,
  longitude: 14.485,
};
const selection: SpinDecision = {
  incidentId: partial.id,
  addressIndex: 0,
  currentLinkStatus: "absent",
};

test.each([
  ["fabricated incident", { ...selection, incidentId: "999999" }],
  ["numeric incident", { ...selection, incidentId: 472584 }],
  ["fabricated address", { ...selection, addressIndex: 1 }],
  ["extra field", { ...selection, confidence: 1 }],
  ["invalid status", { ...selection, currentLinkStatus: "invalid" }],
  ["missing fields", {}],
  ["array", []],
  ["null", null],
])("Responses parsing rejects %s", async (_name, value) => {
  await expect(
    requestSpinMatch(
      pager,
      [partial],
      [address],
      "test-key",
      undefined,
      async () =>
        Response.json({
          status: "completed",
          output: [
            {
              content: [{ type: "output_text", text: JSON.stringify(value) }],
            },
          ],
        }),
    ),
  ).rejects.toThrow("Invalid SPIN match decision");
});

describe("SPIN partial evidence checks", () => {
  test("a partial selection requires a verified selected address", () => {
    expect(checkSpinDecision(pager, [partial], [address], selection)).toEqual(
      selection,
    );
    for (const addresses of [[], [address]]) {
      const decision = { ...selection, addressIndex: null };
      expect(
        checkSpinDecision(pager, [partial], addresses, decision).incidentId,
      ).toBeNull();
    }
    expect(
      checkSpinDecision(pager, [partial], [], selection).incidentId,
    ).toBeNull();
  });

  test("approximate coordinates allow 238 metres but reject beyond 300 metres or 30 minutes", () => {
    const bratislavska = {
      ...partial,
      latitude: 46.063,
      longitude: 14.552,
    };
    const bratislavskaAddress = {
      address: "Bratislavska cesta, 11, Ljubljana",
      latitude: 46.065096087825,
      longitude: 14.55138421315,
    };
    expect(
      checkSpinDecision(pager, [bratislavska], [bratislavskaAddress], selection)
        .incidentId,
    ).toBe(partial.id);
    expect(
      checkSpinDecision(
        pager,
        [{ ...partial, latitude: partial.latitude! + 0.003 }],
        [address],
        selection,
      ).incidentId,
    ).toBeNull();
    expect(
      checkSpinDecision(
        pager,
        [{ ...partial, eventAt: "2026-10-10T17:23:34.077Z" }],
        [address],
        selection,
      ).incidentId,
    ).toBeNull();
  });

  test("the agent can select Ljubljana despite the same verified address in distant Logatec", () => {
    const addresses = [
      { ...address, address: "Pavšičeva ulica, 18, Logatec", latitude: 45.917 },
      address,
    ];
    expect(
      checkSpinDecision(pager, [partial], addresses, {
        ...selection,
        addressIndex: 1,
      }).incidentId,
    ).toBe(partial.id);
    expect(
      checkSpinDecision(pager, [partial], addresses, selection).incidentId,
    ).toBeNull();
  });

  test("two equally supported partial incidents reject a forced model choice", () => {
    expect(
      checkSpinDecision(
        pager,
        [partial, { ...partial, id: "472585" }],
        [address],
        selection,
      ),
    ).toEqual({ ...selection, incidentId: null, addressIndex: null });
    expect(
      checkSpinDecision(
        pager,
        [partial, { ...partial, id: "472585", category: undefined }],
        [address],
        selection,
      ).incidentId,
    ).toBeNull();
  });

  test("a nearby partial rival blocks attachment even when its category and dated RSS title differ", () => {
    const rival = {
      ...partial,
      id: "472585",
      title: "Tehnična in druga pomoč 10. 10. 2026 19:53",
      category: "Tehnična in druga pomoč",
      eventAt: "2026-10-10T17:53:00.000Z",
    };
    expect(
      checkSpinDecision(
        pager,
        [{ ...partial, title: "Požar, eksplozija 10. 10. 2026 19:51" }, rival],
        [address],
        selection,
      ),
    ).toEqual({ ...selection, incidentId: null, addressIndex: null });
  });

  test("a missing current source or municipality-only report remains uncertain", () => {
    const currentPager = { ...pager, currentLinkId: partial.id };
    expect(
      checkSpinDecision(currentPager, [], [], {
        incidentId: null,
        addressIndex: null,
        currentLinkStatus: "invalid",
      }).currentLinkStatus,
    ).toBe("uncertain");
    expect(
      checkSpinDecision(currentPager, [partial], [address], {
        ...selection,
        currentLinkStatus: "valid",
      }),
    ).toEqual({ ...selection, currentLinkStatus: "uncertain" });
  });

  test("an uncertain review cannot silently switch an existing pager link", () => {
    const alternative = {
      ...partial,
      id: "472585",
      description: "Full report",
    };
    expect(
      checkSpinDecision(
        { ...pager, currentLinkId: partial.id },
        [partial, alternative],
        [address],
        {
          incidentId: alternative.id,
          addressIndex: null,
          currentLinkStatus: "uncertain",
        },
      ).incidentId,
    ).toBeNull();
  });

  test("an invalid current link cannot be selected again in the same decision", () => {
    expect(() =>
      checkSpinDecision(
        { ...pager, currentLinkId: partial.id },
        [partial],
        [address],
        { ...selection, currentLinkStatus: "invalid" },
      ),
    ).toThrow();
  });
});

test("Responses parsing uses final_answer and transmits all independently verified address choices", async () => {
  const result = await requestSpinMatch(
    { ...pager, unitName: "Gasilska brigada Ljubljana" },
    [partial],
    [address],
    "test-key",
    undefined,
    async (_url, options) => {
      const body = JSON.parse(options.body as string);
      const data = JSON.parse(body.input[1].content);
      expect(data.pager.verifiedAddressCandidates).toEqual([address]);
      expect(data.pager.unitName).toBe("Gasilska brigada Ljubljana");
      expect(data.incidents[0]).toMatchObject({
        hasNarrative: false,
        distancesMetres: [0],
      });
      return Response.json({
        status: "completed",
        output: [
          {
            type: "message",
            phase: "commentary",
            content: [{ type: "output_text", text: "Checking available data" }],
          },
          {
            type: "message",
            phase: "final_answer",
            content: [{ type: "output_text", text: JSON.stringify(selection) }],
          },
        ],
      });
    },
  );
  expect(result).toEqual(selection);
});
