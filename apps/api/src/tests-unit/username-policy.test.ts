import { describe, it, expect } from "bun:test";

import { setsUsername, usernamePolicy, usernameRefusal } from "../lib/username-policy";

describe("KITSUDEN_USERNAMES", () => {
  it("is staff unless it says everyone; a typo stays staff", () => {
    expect(usernamePolicy({})).toBe("staff");
    expect(usernamePolicy({ KITSUDEN_USERNAMES: "staff" })).toBe("staff");
    expect(usernamePolicy({ KITSUDEN_USERNAMES: " Everyone " })).toBe("everyone");
    expect(usernamePolicy({ KITSUDEN_USERNAMES: "everybody" })).toBe("staff");
  });

  it("only a string sets a username; null clears and is always allowed", () => {
    expect(setsUsername({ username: "admin" })).toBe(true);
    expect(setsUsername({ displayUsername: "admin" })).toBe(true);
    expect(setsUsername({ username: null })).toBe(false);
    expect(setsUsername({ name: "x" })).toBe(false);
    expect(setsUsername(null)).toBe(false);
    expect(usernameRefusal("/update-user", { username: null }, "user", "staff")).toBeNull();
  });

  it("staff: admins and editors set their own, nobody signs up with one", () => {
    const body = { username: "admin" };
    expect(usernameRefusal("/update-user", body, "admin", "staff")).toBeNull();
    expect(usernameRefusal("/update-user", body, "editor", "staff")).toBeNull();
    expect(usernameRefusal("/update-user", body, "user", "staff")).toBe("USERNAME_STAFF_ONLY");
    expect(usernameRefusal("/update-user", body, undefined, "staff")).toBe("USERNAME_STAFF_ONLY");
    expect(usernameRefusal("/sign-up/email", body, undefined, "staff")).toBe(
      "USERNAME_NOT_AT_SIGN_UP"
    );
    expect(
      usernameRefusal("/sign-up/email", { displayUsername: "admin" }, undefined, "staff")
    ).toBe("USERNAME_NOT_AT_SIGN_UP");
  });

  it("everyone: no refusal", () => {
    expect(usernameRefusal("/update-user", { username: "x_y" }, "user", "everyone")).toBeNull();
    expect(
      usernameRefusal("/sign-up/email", { username: "x_y" }, undefined, "everyone")
    ).toBeNull();
  });
});
