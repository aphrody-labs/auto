import { expect, test } from "bun:test";
import { messageCraft } from "./craft-bridge";
test("Craft : fenêtre et origine exactes, charge binaire validée et copie indépendante", () => {
  const fenetre = {} as Window,
    origine = "https://auto.exemple.fr";
  const evenement = (source: Window = fenetre, origin = origine, data: unknown = { type: "gridcraft:ready" }) => ({
    source,
    origin,
    data,
  });
  expect(messageCraft(evenement(), fenetre, "gridcraft", origine)).toEqual({ type: "pret" });
  expect(messageCraft(evenement({} as Window), fenetre, "gridcraft", origine)).toBeNull();
  expect(messageCraft(evenement(fenetre, origine + ".attaquant.fr"), fenetre, "gridcraft", origine)).toBeNull();
  expect(messageCraft(evenement(fenetre, "null"), fenetre, "gridcraft", "null")).toBeNull();
  expect(
    messageCraft(evenement(fenetre, origine, { type: "wordcraft:ready" }), fenetre, "gridcraft", origine),
  ).toBeNull();
  const bytes = new Uint8Array([1, 2]);
  const m = messageCraft(
    evenement(fenetre, origine, { type: "gridcraft:save", name: "Test.xlsx", bytes }),
    fenetre,
    "gridcraft",
    origine,
  );
  expect(m?.type).toBe("sauver");
  bytes[0] = 9;
  if (m?.type === "sauver") expect([...m.octets]).toEqual([1, 2]);
  expect(
    messageCraft(
      evenement(fenetre, origine, { type: "gridcraft:save", name: "../test.xlsx", bytes }),
      fenetre,
      "gridcraft",
      origine,
    )?.type,
  ).toBe("erreur");
  expect(
    messageCraft(
      evenement(fenetre, origine, {
        type: "gridcraft:save",
        name: "test.xlsx",
        bytes: new Uint8Array(20 * 1024 * 1024 + 1),
      }),
      fenetre,
      "gridcraft",
      origine,
    )?.type,
  ).toBe("erreur");
});
