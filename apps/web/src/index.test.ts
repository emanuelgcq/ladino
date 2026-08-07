import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("@ladino/web", () => {
  it("está cableado en el workspace", () => {
    expect(PACKAGE_NAME).toBe("@ladino/web");
  });
});
