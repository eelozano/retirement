import { describe, expect, it } from "vitest";
import { yearBoundary } from "./yearBoundary";

describe("yearBoundary", () => {
  it("makes the stub year and the first full year the same for a January boundary", () => {
    const b = yearBoundary({ year: 2038, month: 1 });
    expect(b.stubYear).toBe(2038);
    expect(b.firstFullYear).toBe(2038);
  });

  it("pushes the first full year to the next January for a December boundary", () => {
    const b = yearBoundary({ year: 2038, month: 12 });
    expect(b.stubYear).toBe(2038);
    expect(b.firstFullYear).toBe(2039);
  });

  it("pushes the first full year forward for any other mid-year boundary", () => {
    const b = yearBoundary({ year: 2038, month: 8 });
    expect(b.stubYear).toBe(2038);
    expect(b.firstFullYear).toBe(2039);
  });
});
