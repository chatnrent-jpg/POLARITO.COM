import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("the site is the SPY desk", () => {
  it("/ redirects to /spy and renders nothing else", () => {
    const page = read("src/app/page.tsx");
    assert.match(page, /redirect\("\/spy"\)/);
    assert.doesNotMatch(page, /Dashboard|LiveModeProvider|liveOptedIn/);
  });

  it("/spy keeps a Sign out button in both the switched-off and the live-desk state", () => {
    const page = read("src/components/spy/SpyDeskPage.tsx");
    assert.match(page, /import LogoutButton from "@\/components\/LogoutButton"/);
    const main = page.slice(page.indexOf("export default function SpyDeskPage"));
    assert.ok(main.indexOf("<LogoutButton />") > 0 && main.indexOf("<LogoutButton />") < main.indexOf("<Desk profile={profile} />"));
    for (const p of ["src/app/spy/page.tsx", "src/app/spy-wwv/page.tsx"]) assert.match(read(p), /<SpyDeskPage profile=/, p);
  });

  it("the Sign out button posts only the logout server action", () => {
    const btn = read("src/components/LogoutButton.tsx");
    assert.match(btn, /logoutAction/);
    assert.doesNotMatch(btn, /fetch\(/);
  });
});
