import { describe, it, expect } from "vitest";
import { buildTenancyFragment, renderPgFragment } from "../tenancy-filter.js";

describe("buildTenancyFragment", () => {
  it("returns IS NULL when tids is empty", () => {
    const f = buildTenancyFragment("tenant_id", []);
    expect(f.sql).toBe("tenant_id IS NULL");
    expect(f.values).toEqual([]);
  });

  it("returns OR-IN expression for non-empty tids", () => {
    const f = buildTenancyFragment("tenant_id", ["a", "b"]);
    expect(f.sql).toBe("(tenant_id IS NULL OR tenant_id IN (?, ?))");
    expect(f.values).toEqual(["a", "b"]);
  });
});

describe("renderPgFragment", () => {
  it("renders $1,$2... placeholders", () => {
    const f = buildTenancyFragment("tenant_id", ["a", "b"]);
    const r = renderPgFragment(f, 3);
    expect(r.sql).toBe("(tenant_id IS NULL OR tenant_id IN ($3, $4))");
    expect(r.values).toEqual(["a", "b"]);
  });

  it("renders single IS NULL with no values", () => {
    const f = buildTenancyFragment("tenant_id", []);
    const r = renderPgFragment(f);
    expect(r.sql).toBe("tenant_id IS NULL");
    expect(r.values).toEqual([]);
  });
});
