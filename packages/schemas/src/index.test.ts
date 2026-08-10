import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("@ladino/schemas", () => {
  it("está cableado en el workspace", () => {
    expect(PACKAGE_NAME).toBe("@ladino/schemas");
  });
});
