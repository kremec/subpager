import { expect, test } from "bun:test";
import { geocodeSpinAddress, spinDistanceMetres } from "./spin-geocode";

function candidate(
  name = "Pavšičeva ulica",
  number = "18",
  town = "Ljubljana",
  longitude = 14.4854,
) {
  return {
    address: `${name}, ${number}, ${town}`,
    attributes: {
      Nbrhd: name,
      City: number,
      Subregion: town,
      Status: "M",
      Addr_type: "Locality",
    },
    score: 100,
    location: { x: longitude, y: 46.0708 },
  };
}

function geocoder(
  suggestions: { text: string; magicKey: string }[],
  results: Record<string, ReturnType<typeof candidate>[]>,
) {
  const calls: URL[] = [];
  const request = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push(url);
    return Response.json(
      url.pathname.endsWith("/suggest")
        ? { suggestions }
        : { candidates: results[url.searchParams.get("magicKey")!] ?? [] },
    );
  }) as typeof fetch;
  return { request, calls };
}

test("resolves an exact original house address through the canonical magic key", async () => {
  const mock = geocoder(
    [{ text: "Pavšičeva ulica, 18, Ljubljana", magicKey: "lj" }],
    { lj: [candidate()] },
  );
  expect(
    await geocodeSpinAddress("Pavsiceva ulica 18, Ljubljana", mock.request),
  ).toEqual([
    {
      address: "Pavšičeva ulica, 18, Ljubljana",
      latitude: 46.0708,
      longitude: 14.4854,
    },
  ]);
  const resolution = mock.calls.find((url) =>
    url.pathname.endsWith("/findAddressCandidates"),
  )!;
  expect(resolution.searchParams.get("SingleLine")).toBe(
    "Pavšičeva ulica, 18, Ljubljana",
  );
  expect(resolution.searchParams.get("magicKey")).toBe("lj");
  expect(resolution.searchParams.get("outSR")).toBe("4326");
  expect(
    mock.calls.filter((url) => url.pathname.endsWith("/findAddressCandidates")),
  ).toHaveLength(1);
});

test("rejects similar names and wrong numbers before resolving suggestions", async () => {
  const mock = geocoder(
    [
      { text: "Pavšičeva ulica, 18a, Logatec", magicKey: "suffix" },
      { text: "Pavšičeva ulica, 1, Ljubljana", magicKey: "number" },
      { text: "Pavšičeva cesta, 18, Ljubljana", magicKey: "name" },
    ],
    {},
  );
  expect(await geocodeSpinAddress("Pavsiceva ulica 18", mock.request)).toEqual(
    [],
  );
  expect(mock.calls).toHaveLength(1);
});

test("accepts only an exact official town prefix without guessing street suffixes", async () => {
  const name = "Cesta 2. grupe odredov";
  const town = "Ivančna Gorica";
  const mock = geocoder(
    [
      { text: `${name}, 29, ${town}, 1295 ${town}`, magicKey: "iv" },
      { text: `${name}, 29, Ljubljana`, magicKey: "wrong-town" },
      {
        text: "Cesta 2. grupe, 29, Ivančna Gorica",
        magicKey: "wrong-street",
      },
      { text: `${name}, 29a, ${town}`, magicKey: "wrong-number" },
    ],
    { iv: [candidate(name, "29", town)] },
  );
  expect(
    await geocodeSpinAddress(
      "Ivancna Gorica Cesta 2. grupe odredov 29",
      mock.request,
    ),
  ).toEqual([
    {
      address: `${name}, 29, ${town}`,
      latitude: 46.0708,
      longitude: 14.4854,
    },
  ]);
  expect(
    mock.calls
      .filter((url) => url.pathname.endsWith("/findAddressCandidates"))
      .map((url) => url.searchParams.get("magicKey")),
  ).toEqual(["iv"]);
});

test("rejects incorrect town and street fields returned for a prefixed suggestion", async () => {
  const mock = geocoder(
    [{ text: "Pavšičeva ulica, 18, Ljubljana", magicKey: "lj" }],
    {
      lj: [
        candidate(undefined, undefined, "Logatec"),
        candidate("Pavšičeva cesta"),
      ],
    },
  );
  expect(
    await geocodeSpinAddress("Ljubljana Pavsiceva ulica 18", mock.request),
  ).toEqual([]);
});

test("rejects unverified prefixes and reordered address words", async () => {
  const mock = geocoder(
    [{ text: "Pavšičeva ulica, 18, Ljubljana", magicKey: "lj" }],
    { lj: [candidate()] },
  );
  for (const location of [
    "Logatec Pavsiceva ulica 18",
    "something Ljubljana Pavsiceva ulica 18",
    "Ljubljana ulica Pavsiceva 18",
  ]) {
    expect(await geocodeSpinAddress(location, mock.request)).toEqual([]);
  }
  expect(
    mock.calls.filter((url) => url.pathname.endsWith("/findAddressCandidates")),
  ).toHaveLength(0);
});

test("rechecks resolved address fields and coordinates instead of trusting the suggestion score", async () => {
  const mock = geocoder(
    [{ text: "Pavšičeva ulica, 18, Ljubljana", magicKey: "lj" }],
    {
      lj: [
        candidate("Pavšičeva ulica", "1"),
        candidate("Pavšičeva cesta"),
        candidate(undefined, undefined, undefined, NaN),
      ],
    },
  );
  expect(await geocodeSpinAddress("Pavsiceva ulica 18", mock.request)).toEqual(
    [],
  );
});

test("preserves independently verified addresses in both possible towns", async () => {
  const mock = geocoder(
    [
      { text: "Pavšičeva ulica, 18, Ljubljana", magicKey: "lj" },
      { text: "Pavšičeva ulica, 18, Logatec", magicKey: "lo" },
    ],
    {
      lj: [candidate()],
      lo: [candidate(undefined, undefined, "Logatec", 14.2208)],
    },
  );
  expect(await geocodeSpinAddress("Pavsiceva ulica 18", mock.request)).toEqual([
    {
      address: "Pavšičeva ulica, 18, Ljubljana",
      latitude: 46.0708,
      longitude: 14.4854,
    },
    {
      address: "Pavšičeva ulica, 18, Logatec",
      latitude: 46.0708,
      longitude: 14.2208,
    },
  ]);
});

test("returns no evidence without a house number and throws on service failures", async () => {
  const mock = geocoder([], {});
  expect(await geocodeSpinAddress("Ljubljana", mock.request)).toEqual([]);
  expect(mock.calls).toHaveLength(0);
  const unavailable = (async () =>
    new Response("Unavailable", { status: 503 })) as unknown as typeof fetch;
  await expect(
    geocodeSpinAddress("Pavsiceva ulica 18", unavailable),
  ).rejects.toThrow("HTTP 503");
});

test("measures approximate SPIN-coordinate distance in metres", () => {
  const address = { latitude: 46.070774417747, longitude: 14.485396876362 };
  expect(spinDistanceMetres(address, address)).toBe(0);
  expect(
    spinDistanceMetres(address, { latitude: 46.071, longitude: 14.485 }),
  ).toBeCloseTo(39.6, 0);
});
