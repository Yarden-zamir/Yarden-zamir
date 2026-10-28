import { defineApp } from "kitshn";

// kitshn 2 (https://kit.yarden-zamir.com): the stats Worker behind the cards of the profile README, public. KV STATS
// keeps the snapshot that the cron refreshes every 30 minutes. GITHUB_TOKEN and CLOUDFLARE_API_TOKEN come from the
// repo secrets KITSHN_GITHUB_TOKEN and KITSHN_CLOUDFLARE_API_TOKEN (K-808).
export default defineApp({
  worker: {
    main: "stats/worker.js",
    compatibilityDate: "2026-09-01",
    // Fetch own hostnames through the public internet, so the site check also reaches other Workers on these zones.
    compatibilityFlags: ["global_fetch_strictly_public"],
    kv: ["STATS"],
    crons: ["*/30 * * * *"],
  },
  deploy: [
    { on: "push", branch: "main", name: "prod", address: "github-stats.yarden-zamir.com", startsIn: "Everyone" },
  ],
});
