import { describe, expect, it } from "vitest";
import type { CashFlowStream } from "../../types/generated/CashFlowStream";
import type { Plan } from "../../types/generated/Plan";
import {
  applyLifespan,
  colaRate,
  lifespanOf,
  lifespanOptions,
  monthlyBenefit,
} from "./pension";

const pension = (overrides: Partial<CashFlowStream> = {}): CashFlowStream => ({
  id: "pension",
  name: "Pension",
  owner: "jordan",
  direction: "Income",
  annual_amount: 18_000,
  start: { AtRetirement: "jordan" },
  end: { AtDeath: "jordan" },
  growth: "None",
  survivor_percentage: null,
  kind: "Pension",
  ...overrides,
});

const person = (id: string, name: string) => ({
  id,
  name,
  birth: { year: 1970, month: 1 },
  retirement: { year: 2035, month: 1 },
  life_expectancy_age: 90,
});

const couple = {
  people: [person("alex", "Alex"), person("jordan", "Jordan")],
} as unknown as Plan;

describe("pension mappings", () => {
  it("shows a yearly amount as its monthly check", () => {
    expect(monthlyBenefit(pension())).toBe(1500);
    expect(monthlyBenefit(pension({ annual_amount: 17_500 }))).toBe(1458.33);
  });

  it("reads a COLA off the growth rule", () => {
    expect(colaRate("None", 0.025)).toBeNull();
    expect(colaRate({ Fixed: 0.02 }, 0.025)).toBe(0.02);
    expect(colaRate("Inflation", 0.025)).toBe(0.025);
  });

  it("ends a single-life pension at the named person's death, with no survivor share", () => {
    const stream = pension({ end: "PlanEnd", survivor_percentage: 0.5 });
    applyLifespan(stream, "Death:alex");
    expect(stream.end).toEqual({ AtDeath: "alex" });
    expect(stream.survivor_percentage).toBeNull();
    expect(lifespanOf(stream)).toBe("Death:alex");
  });

  it("makes a joint pension run to the last death at a 100% share, keeping a share already set", () => {
    const stream = pension();
    applyLifespan(stream, "Joint");
    expect(stream.end).toBe("PlanEnd");
    expect(stream.survivor_percentage).toBe(1);
    expect(lifespanOf(stream)).toBe("Joint");

    const reduced = pension({ end: "PlanEnd", survivor_percentage: 0.5 });
    applyLifespan(reduced, "Joint");
    expect(reduced.survivor_percentage).toBe(0.5);
  });

  it("offers each person's death, and joint only when there is someone to outlive", () => {
    expect(lifespanOptions(couple, pension()).map((o) => o.value)).toEqual([
      "Death:alex",
      "Death:jordan",
      "Joint",
    ]);
    const single = { people: [person("jordan", "Jordan")] } as unknown as Plan;
    expect(lifespanOptions(single, pension()).map((o) => o.value)).toEqual([
      "Death:jordan",
    ]);
  });

  it("keeps an end the card did not write selectable rather than misreporting it", () => {
    const stream = pension({ end: "PlanEnd" });
    expect(lifespanOf(stream)).toBe("Other");
    const options = lifespanOptions(couple, stream);
    expect(options[options.length - 1].value).toBe("Other");
  });
});
