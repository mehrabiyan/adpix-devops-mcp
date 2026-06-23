import { describe, expect, it } from "vitest";
import { APPS, appById, distinctRepos, appsCatalog } from "../src/panel/apps.js";

describe("apps registry", () => {
  it("has analytics + tagmanager + account", () => {
    expect(APPS.map((a) => a.id).sort()).toEqual(["account", "analytics", "tagmanager"]);
    expect(appById("analytics")?.installTool).toBe("adpix_install");
    expect(appById("tagmanager")?.installTool).toBe("tm_install");
    expect(appById("account")?.deployable).toBe(false); // IdP deploy is configured separately
  });

  it("dedupes repos: tagmanager + account share ONE deploy key/repo, analytics is separate", () => {
    const repos = distinctRepos(["analytics", "tagmanager", "account"]);
    expect(repos).toHaveLength(2);
    const tm = repos.find((r) => r.repo === "AdpixTagManager")!;
    expect(tm.keyName).toBe("adpix_tm");
    expect(tm.apps.sort()).toEqual(["AdPix Account (IdP)", "AdPix Tag Manager"]);
    const an = repos.find((r) => r.repo === "adpix")!;
    expect(an.keyName).toBe("adpix");
  });

  it("catalog exposes settings schema (incl required secrets) but no values", () => {
    const cat = appsCatalog();
    const tm = cat.find((a) => a.id === "tagmanager")!;
    expect(tm.settings.find((s) => s.key === "purgeToken")?.secret).toBe(true);
    expect(tm.settings.filter((s) => s.required).map((s) => s.key)).toContain("databaseUrl");
  });
});
