import type { PagerMessage, SpinEvent } from "@/pager/types";

// Confirmed identities from the October 2026 benchmark. Used only by explicit dev previews.
export const spinPreviews: { message: PagerMessage; event: SpinEvent }[] =
  __DEV__
    ? [
        {
          message: {
            id: "00gnyMBvwVctkPYnd5qR",
            receptions: [{ ric: 790273, time: "2026-10-10T11:22:14.403Z" }],
            function: 3,
            type: "alpha",
            content:
              "PROMETNA NESREČA KOLESAR IN AVTOMOBIL, NAJ BI BILO S KOLESARJEM HUDO, KRVAVITVE - DOBROVA-POLHOV GRADEC, ULICA VLADIMIRJA DOLNIČARJA 2",
            location: "DOBROVA-POLHOV GRADEC, ULICA VLADIMIRJA DOLNIČARJA 2",
            spinEventId: "472557",
          },
          event: {
            id: "472557",
            title: "Prometna nesreča 10. 10. 2026 13:18",
            description:
              "Ob 13.18 sta v Ulici Vladimirja Dolničarja v Dobrovi, občina Dobrova-Polhov Gradec, trčila kolesar in osebno vozilo. Gasilci PGD Dobrova so zavarovali kraj dogodka in oskrbeli poškodovanega kolesarja do prihoda reševalcev NMP Ljubljana, ki so ga prevzeli in prepeljali v nadaljnjo oskrbo. Aktivirani so bili tudi gasilci GB Ljubljana, vendar njihova pomoč ni bila potrebna. Na kraju je bila tudi policija.",
            eventAt: "2026-10-10T11:18:04.000Z",
            municipality: "Dobrova-Polhov Gradec",
            category: "Nesreče v cestnem prometu",
            latitude: 46.054,
            longitude: 14.417,
          },
        },
        {
          message: {
            id: "kJH7lBOZEGJPdRl5I0yk",
            receptions: [{ ric: 790793, time: "2026-10-09T12:29:29.316Z" }],
            function: 3,
            type: "alpha",
            content: "GORI OGRAJA PRED HIŠO - GOLO 40",
            location: "GOLO 40",
            spinEventId: "472470",
          },
          event: {
            id: "472470",
            title: "Požar, eksplozija 9. 10. 2026 14:27",
            description:
              "Ob 14.27 je na Golem v občini Ig zagorela ograja ob stanovanjskem objektu. Sosed je požar pogasil pred prihodom gasilcev. Gasilci PGD Golo in Škrilje so dokončno pogasili tleče ostanke in odstranili ožgani del fasade objekta.",
            eventAt: "2026-10-09T12:27:37.000Z",
            municipality: "Ig",
            category: "Požari v naravi oziroma na prostem",
            latitude: 45.909,
            longitude: 14.549,
          },
        },
        {
          message: {
            id: "tgc3eoHUeZ5RBD4h8uTl",
            receptions: [{ ric: 791833, time: "2026-10-09T12:29:28.930Z" }],
            function: 3,
            type: "alpha",
            content: "GORI OGRAJA PRED HIŠO - GOLO 40",
            location: "GOLO 40",
            spinEventId: "472470",
          },
          event: {
            id: "472470",
            title: "Požar, eksplozija 9. 10. 2026 14:27",
            description:
              "Ob 14.27 je na Golem v občini Ig zagorela ograja ob stanovanjskem objektu. Sosed je požar pogasil pred prihodom gasilcev. Gasilci PGD Golo in Škrilje so dokončno pogasili tleče ostanke in odstranili ožgani del fasade objekta.",
            eventAt: "2026-10-09T12:27:37.000Z",
            municipality: "Ig",
            category: "Požari v naravi oziroma na prostem",
            latitude: 45.909,
            longitude: 14.549,
          },
        },
        {
          message: {
            id: "14",
            receptions: [{ ric: 790321, time: "2026-10-08T10:50:58.826Z" }],
            function: 3,
            type: "alpha",
            content:
              "SUM NA ODLAGANJE ODPADKOV, V ZRAKU JE ZAZNATI JEDKOST, PEKOČE - KOČEVJE, CVIŠLERJI 2",
            location: "KOČEVJE, CVIŠLERJI 2",
            spinEventId: "472257",
          },
          event: {
            id: "472257",
            title: "Onesnaženje, nesreče z nevarnimi snovmi",
            description:
              "Ob 12.46 so v Cvišlerjih v občini Kočevje policisti med pregledom odloženih odpadkov zaznali pekoč in dražeč vonj. Gasilci PGD Kočevje so z detektorjem izmerili prisotnost nevarnih snovi v zraku. Detektor je zaznal mešanico neznanih kemikalij. Intervencijo je prevzela Policija.",
            eventAt: "2026-10-08T10:46:50.000Z",
            municipality: "Kočevje",
            category: "Onesnaženja okolja in posegi v okolje",
            latitude: 45.639,
            longitude: 14.888,
          },
        },
        {
          message: {
            id: "11",
            receptions: [{ ric: 790505, time: "2026-10-08T09:12:06.775Z" }],
            function: 3,
            type: "alpha",
            content: "DIMNIŠKI POŽAR - LUKOVICA, ZGORNJE PRAPREČE 5",
            location: "LUKOVICA, ZGORNJE PRAPREČE 5",
            spinEventId: "472252",
          },
          event: {
            id: "472252",
            title: "Požar, eksplozija",
            description:
              "Ob 11.09 je v Zgornjih Praprečah v občini Lukovica zagorelo v dimniku stanovanjske hiše. Pred prihodom gasilcev so domači že začeli gasiti požar. Gasilci PGD Lukovica so požar dokončno pogasili, dimniško tuljavo pregledali s termovizijsko kamero ter odsvetovali nadaljnje kurjenje do prihoda dimnikarja.",
            eventAt: "2026-10-08T09:09:52.000Z",
            municipality: "Lukovica",
            category: "Požari v stanovanjskih stavbah",
            latitude: 46.168,
            longitude: 14.698,
          },
        },
        {
          message: {
            id: "3",
            receptions: [{ ric: 790521, time: "2026-10-07T17:50:26.328Z" }],
            function: 3,
            type: "alpha",
            content:
              "ODPIRANJE VRAT, POLICIJA IN NMP NA LOKACIJI, KAMNIK, RUDNIK PRI RADOMLJAH 1P",
            location: "KAMNIK, RUDNIK PRI RADOMLJAH 1P",
            spinEventId: "472222",
          },
          event: {
            id: "472222",
            title: "Tehnična in druga pomoč",
            description:
              "Ob 19.48 so v naselju Rudnik pri Radomljah v občini Kamnik gasilci PGD Kamnik s tehničnim posegom odprli zaklenjena vrata stanovanjske hiše ter reševalcem NMP in policistom omogočili dostop do preminule osebe. Izmerili so prisotnost plinov, prezračili prostore in uredili razsvetljavo v objektu.",
            eventAt: "2026-10-07T17:48:52.000Z",
            municipality: "Kamnik",
            category: "Tehnična in druga pomoč",
            latitude: 46.195,
            longitude: 14.616,
          },
        },
        {
          message: {
            id: "1",
            receptions: [{ ric: 790241, time: "2026-10-07T15:42:44.612Z" }],
            function: 3,
            type: "alpha",
            content: "IGNIS-GBL: POZAR NAPE  Vodnikovo naselje 34",
            location: "Vodnikovo naselje 34",
            spinEventId: "472214",
          },
          event: {
            id: "472214",
            title: "Požar, eksplozija",
            description:
              "Ob 17.37 je v Vodnikovem naselju v Ljubljani gorela kuhinjska napa v prvem nadstropju stanovanjskega objekta. Pred prihodom gasilcev so stanovalci požar omejili. Gasilci GB Ljubljana in PGD Zgornja Šiška so zavarovali kraj dogodka, pogasili požar, prezračili prostore ter jih pregledali s termovizijsko kamero.",
            eventAt: "2026-10-07T15:37:17.000Z",
            municipality: "Ljubljana",
            category: "Požari v stanovanjskih stavbah",
            latitude: 46.075,
            longitude: 14.473,
          },
        },
      ]
    : [];

export function previewSpinEvent(message: PagerMessage) {
  return spinPreviews.find(
    (preview) =>
      preview.message.id === message.id &&
      preview.message.receptions[0]!.time === message.receptions[0]!.time &&
      preview.message.content === message.content,
  )?.event;
}
