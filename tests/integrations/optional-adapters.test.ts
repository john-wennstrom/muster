import { describe, expect, test } from "bun:test";
import {
  OptionalIntegrationAdapter,
  applyAuthoritativePrecedence,
} from "../../src/integrations/optional-adapters.ts";

describe("optional integration adapters", () => {
  test("absent Serena and Hindsight adapters do not block startup", async () => {
    const serena = new OptionalIntegrationAdapter("serena");
    const hindsight = new OptionalIntegrationAdapter("hindsight");

    expect(await serena.capability()).toMatchObject({ available: false, reads: false, writes: false });
    expect(await hindsight.capability()).toMatchObject({ available: false, reads: false, writes: false });
    expect(await serena.read("symbol")).toEqual([]);
    expect(await hindsight.read("preference")).toEqual([]);
  });

  test("keeps integration reads supplemental when memory conflicts with OpenSpec", async () => {
    const hindsight = new OptionalIntegrationAdapter(
      "hindsight",
      () => true,
      async () => [
        { key: "reviewVerdict", value: "APPROVE" },
        { key: "stylePreference", value: "concise" },
      ],
    );
    const facts = await hindsight.read("current change");
    const merged = applyAuthoritativePrecedence({ reviewVerdict: "REVISE" }, facts);

    expect(facts.every((fact) => fact.authority === "supplemental")).toBeTrue();
    expect(merged).toEqual({ stylePreference: "concise", reviewVerdict: "REVISE" });
  });

  test("routes Serena writes only through the broker", async () => {
    const requests: unknown[] = [];
    const serena = new OptionalIntegrationAdapter(
      "serena",
      () => true,
      async () => [{ key: "symbol", value: "result" }],
      async (request) => {
        requests.push(request);
        return { written: true };
      },
    );

    expect(await serena.write("src/file.ts", { replacement: "value" })).toEqual({ written: true });
    expect(requests).toEqual([{
      tool: "serena_write",
      path: "src/file.ts",
      value: { replacement: "value" },
    }]);
    await expect(new OptionalIntegrationAdapter("hindsight", () => true).write("x", "y"))
      .rejects.toThrow(/write capability is unavailable/);
  });
});