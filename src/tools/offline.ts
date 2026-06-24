import { z } from "zod";
import { withSession } from "../deps.js";
import { ADPIX_REPO_URL } from "../adpix.js";
import { shq, lastLines, redactSecrets } from "../util.js";
import type { ToolDef } from "./types.js";

const TM_REPO_URL = "https://github.com/mehrabiyan/AdpixTagManager.git";
const serverParam = z.string().optional().describe("Target server name. Omit to use the default.");

interface AppDef { repo: string; compose: string; project: string; dir: string; migrate: string }
const APPS: Record<string, AppDef> = {
  analytics: { repo: ADPIX_REPO_URL, compose: "-f compose.yaml -f compose.prod.yaml", project: "adanalytics", dir: "/opt/adpix", migrate: "run --rm migrate" },
  tagmanager: { repo: TM_REPO_URL, compose: "-f deploy/docker-compose.yml", project: "adpix-tm", dir: "/opt/adpix-tagmanager", migrate: "" },
};

/**
 * Air-gap DEEP fallback (when even net_bridge can't open): the MCP host (which has internet) prepares
 * an offline bundle — the repo + PREBUILT docker images (npm/base deps baked in) — and ships it to the
 * target over SFTP; the target installs from local files, never touching GitHub/npm/a registry.
 * Preferred path is still build-on-target via net_bridge; this is the fallback the user asked for.
 *
 * Note: the bundle's images are arch-specific — build on a host matching the target (linux/amd64).
 * Bare targets with no Docker AND no apt egress need Docker delivered too (use net_bridge for that).
 */
export const offlineTools: ToolDef[] = [
  {
    name: "offline_bundle",
    title: "Prepare an offline install bundle (on the MCP host)",
    description:
      "On the MCP host (which has internet), clone a product repo and build + `docker save` its images into a " +
      "single tarball — so an intranet-only target can install with NO GitHub/npm/registry access. Returns the " +
      "local bundle path; feed it to offline_install. Requires Docker on the MCP, matching the target's arch " +
      "(buildImages:false makes a repo-only bundle for a target that can still build).",
    schema: {
      app: z.enum(["analytics", "tagmanager"]).describe("Which product to bundle"),
      repoUrl: z.string().optional(),
      branch: z.string().default("main"),
      buildImages: z.boolean().default(true).describe("Build + docker save the images (captures all deps). false = repo only."),
      platform: z.string().default("linux/amd64").describe("Target image arch (the MCP cross-builds to it if needed)"),
      outDir: z.string().default("/tmp").describe("Where to write the bundle on the MCP host"),
      timeoutSeconds: z.number().int().min(60).max(7200).default(3600),
    },
    annotations: { openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as { app: string; repoUrl?: string; branch: string; buildImages: boolean; platform: string; outDir: string; timeoutSeconds: number };
      const app = APPS[a.app];
      const repo = a.repoUrl || app.repo;
      const stage = `${a.outDir}/adpix-offline-${a.app}`;
      const bundle = `${a.outDir}/adpix-offline-${a.app}.tar.gz`;
      const run = (cmd: string, ms = 120_000) => deps.local(cmd, { timeoutMs: ms });

      const docker = await run(`command -v docker >/dev/null 2>&1 && echo yes || echo no`);
      if (a.buildImages && !/yes/.test(docker.stdout)) return "Docker isn't available on the MCP host — needed to build + save images. Install Docker here, or use buildImages:false (repo-only) + build on the target via net_bridge.";

      const sections: string[] = [`# Offline bundle — ${a.app}`];
      const clone = await run(`rm -rf ${shq(stage)} && mkdir -p ${shq(stage)} && git clone --depth 1 ${shq(repo)} ${shq(stage + "/repo")} 2>&1 && cd ${shq(stage + "/repo")} && (git checkout ${shq(a.branch)} 2>/dev/null || true)`, 300_000);
      if (clone.code !== 0) return sections.join("\n") + `\n\n## Clone FAILED (on the MCP)\n${redactSecrets(lastLines(clone.stdout, 20))}`;
      sections.push(`## Repo\ncloned ${repo} @ ${a.branch}`);

      if (a.buildImages) {
        const build = await run(`cd ${shq(stage + "/repo")} && DOCKER_DEFAULT_PLATFORM=${shq(a.platform)} docker compose ${app.compose} build 2>&1`, a.timeoutSeconds * 1000);
        if (build.code !== 0) return sections.join("\n\n") + `\n\n## Image build FAILED (on the MCP)\n${redactSecrets(lastLines(build.stdout, 25))}`;
        const save = await run(`cd ${shq(stage + "/repo")} && imgs=$(docker compose ${app.compose} config --images 2>/dev/null | sort -u | tr '\\n' ' '); echo "images: $imgs"; docker save $imgs 2>/dev/null | gzip > ${shq(stage + "/images.tar.gz")} && du -h ${shq(stage + "/images.tar.gz")}`, a.timeoutSeconds * 1000);
        sections.push(`## Images\n${lastLines(save.stdout, 4)}`);
      }

      await run(`cat > ${shq(stage + "/manifest.json")} <<EOF\n{"app":"${a.app}","repo":"${repo}","branch":"${a.branch}","images":${a.buildImages},"platform":"${a.platform}"}\nEOF`);
      const pack = await run(`tar czf ${shq(bundle)} -C ${shq(stage)} . 2>&1 && du -h ${shq(bundle)} | cut -f1`, 600_000);
      if (pack.code !== 0) return sections.join("\n\n") + `\n\n## Pack FAILED\n${lastLines(pack.stdout, 10)}`;

      sections.push(
        `## Done\nBundle: ${bundle} (${pack.stdout.trim()})`,
        `Install it on the offline target:\n\`\`\`\noffline_install server=<target> app=${a.app} bundlePath=${bundle}\n\`\`\``,
        a.buildImages ? `(images are ${a.platform} — the target must match.)` : `(repo-only — the target builds the images itself; needs Docker + base images, e.g. via net_bridge.)`
      );
      return sections.join("\n\n");
    },
  },

  {
    name: "offline_install",
    title: "Install a product from an offline bundle",
    description:
      "Install a product on an intranet-only target from a bundle prepared by offline_bundle: streams the bundle " +
      "to the target over SFTP, loads the prebuilt images (docker load), lays down the repo, and brings the stack " +
      "up WITHOUT building or pulling (--no-build) + runs migrations. No GitHub/npm/registry access needed.",
    schema: {
      server: serverParam,
      app: z.enum(["analytics", "tagmanager"]),
      bundlePath: z.string().describe("Path to the bundle ON THE MCP HOST (from offline_bundle)"),
      dir: z.string().optional().describe("Install dir on the target (default: the product's standard dir)"),
      timeoutSeconds: z.number().int().min(60).max(7200).default(2400),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; app: string; bundlePath: string; dir?: string; timeoutSeconds: number };
      const app = APPS[a.app];
      const dir = a.dir || app.dir;
      return withSession(deps, a.server, async (s, srv) => {
        if (!s.putFile) return "This session can't stream files (SFTP). Offline install needs the real SSH transport.";
        const docker = await s.exec(`command -v docker >/dev/null && docker compose version >/dev/null 2>&1 && echo ok || echo no`);
        if (docker.stdout.trim() !== "ok") return `Docker (with compose) isn't on ${srv.name}. A fully bare target needs Docker delivered first — open net_bridge and apt-install it, then re-run offline_install.`;

        const sections: string[] = [`# Offline install — ${a.app} on ${srv.name}`];
        const remoteBundle = `/tmp/adpix-offline-${a.app}.tar.gz`;
        const stage = `/tmp/adpix-offline-${a.app}`;
        try { await s.putFile(a.bundlePath, remoteBundle, "600"); }
        catch (e) { return sections.join("\n") + `\n\nFAILED to upload the bundle: ${(e as Error).message}`; }
        sections.push(`## Transfer\nstreamed ${a.bundlePath} → ${srv.name}:${remoteBundle}`);

        const unpack = await s.exec(`rm -rf ${shq(stage)} && mkdir -p ${shq(stage)} && tar xzf ${shq(remoteBundle)} -C ${shq(stage)} 2>&1`, { timeoutMs: 300_000 });
        if (unpack.code !== 0) return sections.join("\n\n") + `\n\n## Unpack FAILED\n${lastLines(unpack.stdout, 10)}`;

        const load = await s.exec(`[ -f ${shq(stage + "/images.tar.gz")} ] && (gunzip -c ${shq(stage + "/images.tar.gz")} | docker load 2>&1) || echo 'no images in bundle — will build on target'`, { timeoutMs: a.timeoutSeconds * 1000 });
        sections.push(`## Images\n${lastLines(load.stdout, 6)}`);

        await s.exec(`mkdir -p ${shq(dir)} && cp -a ${shq(stage + "/repo/.")} ${shq(dir + "/")} 2>&1`, { timeoutMs: 120_000 });
        const hasImages = /Loaded image/i.test(load.stdout);
        const up = await s.exec(`cd ${shq(dir)} && docker compose ${app.compose} -p ${shq(app.project)} up -d ${hasImages ? "--no-build" : ""} 2>&1`, { timeoutMs: a.timeoutSeconds * 1000 });
        sections.push(`## Up (exit ${up.code})\n${redactSecrets(lastLines(up.stdout, 15))}`);
        if (up.code !== 0) return sections.join("\n\n") + `\n\nBring-up FAILED — see above.`;

        if (app.migrate) {
          const mig = await s.exec(`cd ${shq(dir)} && docker compose ${app.compose} -p ${shq(app.project)} ${app.migrate} 2>&1`, { timeoutMs: 600_000 });
          sections.push(`## Migrate (exit ${mig.code})\n${lastLines(mig.stdout, 8)}`);
        }
        sections.push(`## Done\n${a.app} installed offline at ${dir} on ${srv.name} — no internet used. Verify with adpix_status / tm_status.`);
        return sections.join("\n\n");
      });
    },
  },
];
