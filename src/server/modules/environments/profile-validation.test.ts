import { describe, expect, it } from "vitest";

import { validateEnvironment, validateProfileName } from "./profile-validation";

describe("environment profile input policy", () => {
  it("normalizes a profile name and variable ordering without changing values", () => {
    expect(validateProfileName(" staging-1 ")).toBe("staging-1");
    const environment = validateEnvironment({ Z_FEATURE: "enabled", A_URL: "https://example.test/a?b=c" });
    expect(Object.keys(environment)).toEqual(["A_URL", "Z_FEATURE"]);
    expect(environment.A_URL).toBe("https://example.test/a?b=c");
  });

  it.each(["NODE_OPTIONS", "PORT", "DYLD_INSERT_LIBRARIES", "PYTHONPATH"])("rejects controller-owned %s", (name) => {
    expect(() => validateEnvironment({ [name]: "value" })).toThrow("zarządzana przez kontroler");
  });

  it("keeps accepting temporary-directory names that the queue overrides per run", () => {
    expect(validateEnvironment({ TMPDIR: "/var/tmp/app", TMP: "/var/tmp/app", TEMP: "/var/tmp/app" })).toEqual({ TEMP: "/var/tmp/app", TMP: "/var/tmp/app", TMPDIR: "/var/tmp/app" });
  });

  it.each([" leading", "trailing ", "line\nbreak", "null\0byte"])("rejects invalid values without trimming them", (value) => {
    expect(() => validateEnvironment({ APP_VALUE: value })).toThrow("Nieprawidłowa wartość");
  });

  it("rejects profile path syntax and too many variables", () => {
    expect(() => validateProfileName("../staging")).toThrow("Nieprawidłowa nazwa");
    expect(() => validateEnvironment(Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`APP_${index}`, "1"])))).toThrow("100 zmiennych");
  });
});
