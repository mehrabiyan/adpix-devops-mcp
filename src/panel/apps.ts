import { ADPIX_REPO_URL } from "../adpix.js";
import { parseGithubRemote } from "../github.js";

/**
 * The deployable-apps catalog — the single, extensible source the Setup Wizard drives. Adding a
 * future app is just one entry here: its GitHub repo, the MCP deploy-key name (apps that share a
 * repo share a key), the install tool + compose project, and the settings the operator must supply.
 *
 * Today: Analytics (its own repo) + Tag Manager and the Account/IdP center (both in the
 * AdpixTagManager repo, so one deploy key covers both).
 */
const TM_REPO_URL = "https://github.com/mehrabiyan/AdpixTagManager.git";

export interface AppSetting { key: string; label: string; required: boolean; secret?: boolean; placeholder?: string; type?: "toggle"; hides?: string[]; requiredUnless?: string }
export interface AppDef {
  id: string;
  name: string;
  blurb: string;
  repoUrl: string;
  keyName: string;       // MCP deploy-key name (shared per repo)
  project: string;       // docker compose project
  deployable: boolean;   // false = repo/key managed here but deploy is configured separately
  installTool?: string;  // tool the wizard runs to deploy it
  defaultDir?: string;
  settings: AppSetting[];
  urlEnv?: string;       // .env key whose value is the public URL once up
}

export const APPS: AppDef[] = [
  {
    id: "analytics",
    name: "AdPix Analytics",
    blurb: "Privacy-first web analytics — ingest + ClickHouse + dashboard.",
    repoUrl: ADPIX_REPO_URL,
    keyName: "adpix",
    project: "adanalytics",
    deployable: true,
    installTool: "adpix_install",
    urlEnv: "PUBLIC_BASE_URL",
    settings: [
      { key: "domain", label: "Domain (HTTPS via Caddy)", required: false, placeholder: "analytics.example.com — omit for HTTP-on-IP" },
      { key: "adminEmail", label: "Admin email", required: false, placeholder: "admin@example.com" },
    ],
  },
  {
    id: "tagmanager",
    name: "AdPix Tag Manager",
    blurb: "Tag delivery — edge + Varnish + CDN (api:8686, edge:8585). Bundles its object store (MinIO) and, optionally, its control DB as containers.",
    repoUrl: TM_REPO_URL,
    keyName: "adpix_tm",
    project: "adpix-tm",
    deployable: true,
    installTool: "tm_install",
    defaultDir: "/opt/adpix-tagmanager",
    settings: [
      { key: "dbContainer", label: "Create the control DB as a Postgres container on this server (no external DB needed)", required: false, type: "toggle", hides: ["databaseUrl"] },
      { key: "databaseUrl", label: "Control DB URL", required: true, requiredUnless: "dbContainer", placeholder: "postgres://user:pass@host:5432/db" },
      { key: "authIssuer", label: "Account center (OIDC issuer) — blank = use the Account app you deploy here", required: false, placeholder: "auto-wired from the Account app, or https://account.adpix.io" },
      { key: "s3AccessKey", label: "Object store — MinIO access key (runs as a container here; blank = auto-generate)", required: false, placeholder: "auto-generated" },
      { key: "s3SecretKey", label: "Object store — MinIO secret key (blank = auto-generate)", required: false, secret: true, placeholder: "auto-generated" },
      { key: "purgeToken", label: "Purge token, shared with Varnish (blank = auto-generate)", required: false, secret: true, placeholder: "auto-generated" },
    ],
  },
  {
    id: "account",
    name: "AdPix Account (IdP)",
    blurb: "Central identity / OIDC account center (apps/auth). Self-contained container with an embedded DB; shares the Tag Manager repo + deploy key.",
    repoUrl: TM_REPO_URL,
    keyName: "adpix_tm",
    project: "adpix-account",
    deployable: true,
    installTool: "account_install",
    defaultDir: "/opt/adpix-tagmanager",
    urlEnv: "AUTH_ISSUER",
    settings: [
      { key: "domain", label: "Domain (HTTPS) — blank = http on the server IP:9696", required: false, placeholder: "account.example.com" },
      { key: "adminEmail", label: "Bootstrap admin email", required: false, placeholder: "admin@example.com" },
    ],
  },
  {
    id: "console",
    name: "AdPix Tag Manager Console",
    blurb: "The Tag Manager management UI (apps/console, Next.js). Shares the Tag Manager repo + deploy key. NEXT_PUBLIC_* are baked at build time, so a URL change needs a rebuild.",
    repoUrl: TM_REPO_URL,
    keyName: "adpix_tm",
    project: "adpix-console",
    deployable: true,
    installTool: "console_install",
    defaultDir: "/opt/adpix-tagmanager",
    urlEnv: "NEXT_PUBLIC_TAGMANAGER_URL",
    settings: [
      { key: "domain", label: "Domain (HTTPS) — blank = http on the server IP:3000", required: false, placeholder: "tag.example.com" },
      { key: "authIssuer", label: "Account center (OIDC issuer) — blank = use the Account app you deploy here", required: false, placeholder: "auto-wired from the Account app" },
      { key: "analyticsUrl", label: "Analytics dashboard URL (optional)", required: false, placeholder: "https://app.example.com" },
    ],
  },
];

export function appById(id: string): AppDef | undefined { return APPS.find((a) => a.id === id); }

/** Distinct GitHub repos across the selected apps (so a shared repo → one key + one verify). */
export function distinctRepos(appIds: string[]): { repoUrl: string; keyName: string; owner: string; repo: string; apps: string[] }[] {
  const out: Record<string, { repoUrl: string; keyName: string; owner: string; repo: string; apps: string[] }> = {};
  for (const id of appIds) {
    const app = appById(id); if (!app) continue;
    const gh = parseGithubRemote(app.repoUrl); if (!gh) continue;
    const key = `${gh.owner}/${gh.repo}`;
    if (!out[key]) out[key] = { repoUrl: app.repoUrl, keyName: app.keyName, owner: gh.owner, repo: gh.repo, apps: [] };
    out[key].apps.push(app.name);
  }
  return Object.values(out);
}

/** Public catalog (no secrets) for the wizard UI. */
export function appsCatalog() {
  return APPS.map((a) => ({ id: a.id, name: a.name, blurb: a.blurb, repo: a.repoUrl, deployable: a.deployable, installTool: a.installTool, defaultDir: a.defaultDir, settings: a.settings }));
}
