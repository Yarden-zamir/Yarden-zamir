// GitHub stats card for the Yarden-zamir profile README.
// Runs as the Cloudflare Worker "github-stats" on github-stats.yarden-zamir.com.
//
// A cron run collects the data and stores one snapshot in KV. A card request only
// reads that snapshot, because a cold GitHub query takes longer than GitHub's
// image proxy waits.
//
// Secrets: GITHUB_TOKEN (reads the counted GitHub data) and CLOUDFLARE_API_TOKEN
// (Zone Read, DNS Read and Analytics Read on all zones, to find live sites).
// Binding: STATS, a KV namespace.

const LOGIN = "Yarden-zamir";
const USER_ID = "MDQ6VXNlcjgxNzg0MTM="; // GitHub node id of LOGIN, fixed for the account.
const CARD_CACHE_SECONDS = 30 * 60;
const GRAVEYARD_MS = 2 * 365.25 * 24 * 60 * 60 * 1000;
// Housekeeping commits that do not count as work on a project (the licensing pass of 2026-10-01).
// Limit: a later real commit with the same headline is ignored too. Revisit if license commits recur.
const IGNORED_HEADLINES = new Set(["chore: add MIT license"]);
// The free Workers plan allows 50 subrequests per run. The run uses about 12 for
// GitHub and Cloudflare, so it checks at most this many sites and rotates through the rest.
const SITE_CHECKS_PER_RUN = 30;
const SITE_LOOKBACK_DAYS = 7;

export default {
  async fetch(request, env) {
    const snapshot = await env.STATS.get("snapshot", "json");
    if (!snapshot) return new Response("The first cron run has not finished yet", { status: 503 });
    return new Response(renderCard(snapshot), {
      headers: {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": `public, max-age=${CARD_CACHE_SECONDS}`,
      },
    });
  },

  async scheduled(event, env) {
    const [stats, sites] = await Promise.all([fetchStats(env.GITHUB_TOKEN), refreshSites(env)]);
    await env.STATS.put("snapshot", JSON.stringify({ stats, sites, updatedAt: new Date().toISOString() }));
  },
};

// ---------- GitHub ----------

const PROFILE_QUERY = `query ($login: String!, $yearStart: DateTime!) {
  user(login: $login) {
    name
    followers { totalCount }
    thisYear: contributionsCollection(from: $yearStart) {
      totalCommitContributions
      contributionCalendar { totalContributions weeks { contributionDays { contributionCount } } }
    }
    lastYear: contributionsCollection { totalPullRequestReviewContributions }
    pullRequests { totalCount }
    openIssues: issues(states: OPEN) { totalCount }
    closedIssues: issues(states: CLOSED) { totalCount }
    repositoriesContributedTo(first: 1, contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]) { totalCount }
  }
}`;

const REPOS_QUERY = `query ($login: String!, $userId: ID!, $after: String) {
  user(login: $login) {
    repositories(first: 50, after: $after, ownerAffiliations: OWNER) {
      pageInfo { hasNextPage endCursor }
      nodes {
        isFork
        createdAt
        stargazerCount
        releases { totalCount }
        defaultBranchRef { target { ... on Commit { history(first: 3, author: { id: $userId }) { nodes { committedDate messageHeadline } } } } }
      }
    }
  }
}`;

async function github(token, query, variables) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json", "User-Agent": "github-stats.yarden-zamir.com" },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`GitHub GraphQL returned ${response.status}`);
  const { data, errors } = await response.json();
  if (errors?.length) throw new Error(`GitHub GraphQL errors: ${errors.map((e) => e.message).join("; ")}`);
  if (!data?.user) throw new Error(`GitHub user ${LOGIN} not found`);
  return data.user;
}

async function fetchStats(token) {
  if (!token) throw new Error("GITHUB_TOKEN secret is not set");
  const now = Date.now();
  const year = new Date(now).getUTCFullYear();
  const yearStart = `${year}-01-01T00:00:00Z`;

  const user = await github(token, PROFILE_QUERY, { login: LOGIN, yearStart });
  const repos = [];
  for (let after = null; ; ) {
    const page = (await github(token, REPOS_QUERY, { login: LOGIN, userId: USER_ID, after })).repositories;
    repos.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }

  const ownCommits = (repo) =>
    (repo.defaultBranchRef?.target?.history?.nodes ?? []).filter((c) => !IGNORED_HEADLINES.has(c.messageHeadline));
  const projects = repos.filter((r) => !r.isFork);
  const isGrave = (repo) => {
    if (now - Date.parse(repo.createdAt) < GRAVEYARD_MS) return false;
    const last = ownCommits(repo)[0];
    return !last || now - Date.parse(last.committedDate) > GRAVEYARD_MS;
  };

  return {
    name: user.name ?? LOGIN,
    year,
    contributions: user.thisYear.contributionCalendar.totalContributions,
    weekly: user.thisYear.contributionCalendar.weeks.map((w) => w.contributionDays.reduce((s, d) => s + d.contributionCount, 0)),
    // restrictedContributionsCount covers every private contribution type, so it is not added to commits.
    commits: user.thisYear.totalCommitContributions,
    prs: user.pullRequests.totalCount,
    issues: user.openIssues.totalCount + user.closedIssues.totalCount,
    contributedTo: user.repositoriesContributedTo.totalCount,
    reviews: user.lastYear.totalPullRequestReviewContributions,
    followers: user.followers.totalCount,
    stars: projects.reduce((s, r) => s + r.stargazerCount, 0),
    releases: repos.reduce((s, r) => s + r.releases.totalCount, 0),
    newProjects: projects.filter((r) => Date.parse(r.createdAt) >= Date.parse(yearStart)).length,
    graveyard: projects.filter(isGrave).length,
    touristForks: repos.filter((r) => r.isFork && ownCommits(r).length === 0).length,
  };
}

// ---------- Sites ----------

async function cloudflare(token, path, init = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const body = await response.json();
  if (!response.ok || body.success === false) throw new Error(`Cloudflare ${path} failed: ${JSON.stringify(body.errors)}`);
  return body;
}

// Hostnames come from two places: DNS records, and DNS analytics. Analytics also
// catch hosts that only exist behind a wildcard record, such as KitSHn sites.
// Scanners query made-up names too, so only an HTTPS check decides what is live.
// Limit: a site with no DNS lookups in SITE_LOOKBACK_DAYS and no own record drops off.
async function candidateHosts(token) {
  const zones = (await cloudflare(token, "/zones?per_page=50")).result;
  const hosts = new Set();
  for (const zone of zones) {
    const records = (await cloudflare(token, `/zones/${zone.id}/dns_records?per_page=500`)).result;
    for (const r of records) if (["A", "AAAA", "CNAME"].includes(r.type)) hosts.add(r.name);
  }
  const since = new Date(Date.now() - SITE_LOOKBACK_DAYS * 864e5).toISOString().slice(0, 19) + "Z";
  const analytics = await cloudflare(token, "/graphql", {
    method: "POST",
    body: JSON.stringify({
      query: `query ($zones: [String!], $since: Time!) { viewer { zones(filter: { zoneTag_in: $zones }) {
        dnsAnalyticsAdaptiveGroups(limit: 1000, filter: { datetime_geq: $since, responseCode: "NOERROR" }) { dimensions { queryName } } } } }`,
      variables: { zones: zones.map((z) => z.id), since },
    }),
  });
  if (analytics.errors?.length) throw new Error(`Cloudflare analytics errors: ${JSON.stringify(analytics.errors)}`);
  for (const zone of analytics.data.viewer.zones) for (const g of zone.dnsAnalyticsAdaptiveGroups) hosts.add(g.dimensions.queryName.toLowerCase());

  // Skip wildcards, service records and pull request previews.
  return [...hosts].filter((h) => !h.includes("*") && !h.startsWith("_") && !h.startsWith("pr."));
}

const LOGIN_PATHS = ["/auth", "login", "sign_in", "signin"];

async function checkSite(host) {
  try {
    const response = await fetch(`https://${host}/`, {
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
      headers: { "User-Agent": "github-stats.yarden-zamir.com site check" },
    });
    if (response.status >= 300 && response.status < 400) {
      const target = new URL(response.headers.get("Location") ?? "/", `https://${host}/`);
      if (target.host !== host) return { state: "redirect" };
      return { state: LOGIN_PATHS.some((p) => target.pathname.includes(p)) ? "gated" : "public" };
    }
    if (response.status === 401 || response.status === 403) return { state: "gated" };
    if (!response.ok || !(response.headers.get("Content-Type") ?? "").includes("text/html")) return { state: "down" };

    let title = "";
    await new HTMLRewriter().on("title", { text: (t) => { title += t.text; } }).transform(response).arrayBuffer();
    return { state: "public", title: title.trim() };
  } catch {
    return { state: "down" };
  }
}

async function refreshSites(env) {
  if (!env.CLOUDFLARE_API_TOKEN) throw new Error("CLOUDFLARE_API_TOKEN secret is not set");
  const hosts = await candidateHosts(env.CLOUDFLARE_API_TOKEN);
  const previous = (await env.STATS.get("sites", "json")) ?? {};
  const state = Object.fromEntries(hosts.map((h) => [h, previous[h] ?? { checkedAt: 0 }]));

  const due = hosts.sort((a, b) => state[a].checkedAt - state[b].checkedAt).slice(0, SITE_CHECKS_PER_RUN);
  const results = await Promise.all(due.map(checkSite));
  due.forEach((host, i) => { state[host] = { ...results[i], checkedAt: Date.now() }; });
  await env.STATS.put("sites", JSON.stringify(state));

  // One site often answers on several hosts (apex, www, an alias domain). Keep the
  // shortest host per page title.
  const byTitle = new Map();
  for (const [host, s] of Object.entries(state)) {
    if (s.state !== "public") continue;
    const key = s.title || host;
    const kept = byTitle.get(key);
    if (!kept || host.length < kept.host.length) byTitle.set(key, { host, title: s.title ?? "" });
  }
  return {
    live: [...byTitle.values()].sort((a, b) => a.host.localeCompare(b.host)),
    gated: Object.values(state).filter((s) => s.state === "gated").length,
  };
}

// ---------- Card ----------

// Same weights and medians as github-readme-stats, so the grade matches the old card.
function rank({ commits, prs, issues, reviews, stars, followers }) {
  const exponentialCdf = (x) => 1 - 2 ** -x;
  const logNormalCdf = (x) => x / (1 + x);
  const parts = [
    [2, exponentialCdf(commits / 250)],
    [3, exponentialCdf(prs / 50)],
    [1, exponentialCdf(issues / 25)],
    [1, exponentialCdf(reviews / 2)],
    [4, logNormalCdf(stars / 50)],
    [1, logNormalCdf(followers / 10)],
  ];
  const totalWeight = parts.reduce((sum, [weight]) => sum + weight, 0);
  const score = parts.reduce((sum, [weight, value]) => sum + weight * value, 0) / totalWeight;
  const percentile = (1 - score) * 100;
  const levels = [[1, "S"], [12.5, "A+"], [25, "A"], [37.5, "A-"], [50, "B+"], [62.5, "B"], [75, "B-"], [87.5, "C+"], [100, "C"]];
  const [, level] = levels.find(([threshold]) => percentile <= threshold);
  return { level, percentile };
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const format = (n) => compact.format(n).toLowerCase();
const full = new Intl.NumberFormat("en");
const escapeXml = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const WIDTH = 480;
const LEFT = 28;
const INNER = WIDTH - 2 * LEFT;

function sparkline(weekly, top) {
  const slots = 53;
  const step = INNER / slots;
  const max = Math.max(1, ...weekly);
  const height = 34;
  return Array.from({ length: slots }, (_, i) => {
    const x = (LEFT + i * step).toFixed(1);
    if (i >= weekly.length) return `<rect class="future" x="${x}" y="${top + height - 2}" width="${(step - 2).toFixed(1)}" height="2" rx="1"/>`;
    const h = Math.max(2, (weekly[i] / max) * height);
    return `<rect class="bar" x="${x}" y="${(top + height - h).toFixed(1)}" width="${(step - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" style="animation-delay:${i * 12}ms"/>`;
  }).join("");
}

function iconRow(count, top, draw) {
  const step = 10;
  const fits = Math.floor(INNER / step);
  const shown = count > fits ? fits - 3 : count;
  const icons = Array.from({ length: shown }, (_, i) => draw(LEFT + i * step, top)).join("");
  const rest = count - shown;
  return rest > 0 ? `${icons}<text class="small" x="${LEFT + shown * step + 4}" y="${top + 12}">+${rest}</text>` : icons;
}
const tombstone = (x, y) => `<path class="grave" d="M${x} ${y + 14}v-9a3.5 3.5 0 0 1 7 0v9z"/>`;
const suitcase = (x, y) => `<g class="tourist"><rect x="${x}" y="${y + 5}" width="8" height="9" rx="1.5"/><path d="M${x + 2.5} ${y + 5}v-2h3v2" fill="none"/></g>`;

function chips(sites, top) {
  const out = [];
  let x = LEFT;
  let y = top;
  for (const { host, title } of sites) {
    const label = host.startsWith("www.") ? host.slice(4) : host;
    // Dim the registered domain so the part that names the site stands out.
    const parts = label.split(".");
    const domain = parts.slice(-2).join(".");
    const sub = parts.slice(0, -2).join(".");
    const width = Math.round(label.length * 6.4 + 32);
    if (x + width > WIDTH - LEFT) { x = LEFT; y += 30; }
    out.push(`<g><title>${escapeXml(title || label)}</title><rect class="chip" x="${x}" y="${y}" width="${width}" height="22" rx="11"/><circle class="live" cx="${x + 12}" cy="${y + 11}" r="3.5"/><text class="chiptext" x="${x + 21}" y="${y + 15}">${sub ? `${escapeXml(sub)}<tspan class="domain">.${escapeXml(domain)}</tspan>` : escapeXml(domain)}</text></g>`);
    x += width + 8;
  }
  return { svg: out.join(""), bottom: sites.length ? y + 22 : top };
}

function renderCard({ stats, sites }) {
  const { level, percentile } = rank(stats);
  const ringR = 30;
  const circumference = 2 * Math.PI * ringR;

  const grid = [
    ["Stars earned", stats.stars], ["Contributed to", stats.contributedTo],
    [`Commits in ${stats.year}`, stats.commits], ["Releases shipped", stats.releases],
    ["Pull requests", stats.prs], [`New projects in ${stats.year}`, stats.newProjects],
    ["Issues", stats.issues], ["Code reviews", stats.reviews],
  ];
  const gridTop = 236;
  const gridSvg = grid.map(([label, value], i) => {
    const column = i % 2;
    const y = gridTop + Math.floor(i / 2) * 26;
    const x = column === 0 ? LEFT : WIDTH / 2 + 8;
    const valueX = column === 0 ? WIDTH / 2 - 16 : WIDTH - LEFT;
    return `<g class="row" style="animation-delay:${300 + i * 50}ms"><text class="label" x="${x}" y="${y}">${label}</text><text class="value" x="${valueX}" y="${y}" text-anchor="end">${format(value)}</text></g>`;
  }).join("");

  const funTop = gridTop + 4 * 26 + 18;
  const sitesTop = funTop + 104;
  const siteChips = chips(sites.live, sitesTop + 14);
  const gatedNote = sites.gated ? `<text class="small" x="${WIDTH - LEFT}" y="${sitesTop}" text-anchor="end">+${sites.gated} behind a login</text>` : "";
  const height = siteChips.bottom + 26;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-labelledby="title">
<title id="title">${escapeXml(stats.name)}'s GitHub stats: ${full.format(stats.contributions)} contributions in ${stats.year}, grade ${level}</title>
<style>
  text { font-family: ui-sans-serif, -apple-system, "Segoe UI", sans-serif; }
  .card { fill: #fbf7f1; stroke: #eadfce; }
  .name { fill: #c4573a; font-size: 18px; font-weight: 600; }
  .caps { fill: #9a8a78; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; }
  .hero { fill: #2b2420; font-size: 40px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .herolabel { fill: #6b5d4f; font-size: 14px; }
  .label { fill: #6b5d4f; font-size: 13.5px; }
  .value { fill: #2b2420; font-size: 13.5px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .small { fill: #9a8a78; font-size: 11.5px; }
  .funlabel { fill: #2b2420; font-size: 13.5px; font-weight: 600; }
  .bar { fill: #c4573a; transform-box: fill-box; transform-origin: bottom; animation: grow 500ms ease-out both; }
  .future { fill: #eadfce; }
  .track { stroke: #eadfce; }
  .ring { stroke: #c4573a; animation: draw 900ms ease-out both; }
  .grade { fill: #2b2420; font-size: 20px; font-weight: 700; }
  .grave { fill: #b4a796; }
  .tourist rect { fill: #e0a458; }
  .tourist path { stroke: #e0a458; stroke-width: 1.4; }
  .chip { fill: #f3ebdf; stroke: #eadfce; }
  .chiptext { fill: #2b2420; font-size: 12px; font-weight: 500; }
  .domain { fill: #9a8a78; font-weight: 400; }
  .live { fill: #3fa66b; }
  .rule { stroke: #eadfce; }
  @media (prefers-color-scheme: dark) {
    .card { fill: #22262f; stroke: #343a46; }
    .name { fill: #e8876b; }
    .caps, .small { fill: #8d8577; }
    .hero, .value, .grade, .funlabel, .chiptext { fill: #f3e9da; }
    .herolabel, .label { fill: #b9ae9d; }
    .bar { fill: #e8876b; }
    .ring { stroke: #e8876b; }
    .future, .chip { fill: #2c313c; }
    .track, .rule, .chip { stroke: #343a46; }
    .grave { fill: #6d6a66; }
    .domain { fill: #8d8577; }
    .live { fill: #4cc083; }
  }
  .row { animation: fade 400ms ease-out both; }
  @keyframes fade { from { opacity: 0; } }
  @keyframes grow { from { transform: scaleY(0); } }
  @keyframes draw { from { stroke-dashoffset: ${circumference.toFixed(2)}; } }
  @media (prefers-reduced-motion: reduce) { .row, .bar, .ring { animation: none; } }
</style>
<rect class="card" x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" rx="18"/>

<text class="name" x="${LEFT}" y="40">${escapeXml(stats.name)}</text>
<text class="caps" x="${LEFT}" y="58">GITHUB · ${stats.year}</text>
<g transform="translate(${WIDTH - LEFT - ringR} 62)">
  <circle class="track" r="${ringR}" fill="none" stroke-width="6"/>
  <circle class="ring" r="${ringR}" fill="none" stroke-width="6" stroke-linecap="round" transform="rotate(-90)"
    stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${(circumference * percentile / 100).toFixed(2)}"/>
  <text class="grade" y="7" text-anchor="middle">${level}</text>
  <text class="small" y="${ringR + 18}" text-anchor="middle">top ${Math.max(1, Math.round(percentile))}%</text>
</g>

<text class="hero" x="${LEFT}" y="118">${full.format(stats.contributions)}</text>
<text class="herolabel" x="${LEFT}" y="140">contributions in ${stats.year}</text>
${sparkline(stats.weekly, 156)}

<line class="rule" x1="${LEFT}" x2="${WIDTH - LEFT}" y1="${gridTop - 24}" y2="${gridTop - 24}"/>
${gridSvg}

<line class="rule" x1="${LEFT}" x2="${WIDTH - LEFT}" y1="${funTop - 14}" y2="${funTop - 14}"/>
<text class="funlabel" x="${LEFT}" y="${funTop + 4}">Graveyard <tspan class="small">· ${stats.graveyard} projects without a commit from me in 2+ years</tspan></text>
${iconRow(stats.graveyard, funTop + 12, tombstone)}
<text class="funlabel" x="${LEFT}" y="${funTop + 52}">Tourist forks <tspan class="small">· ${stats.touristForks} forks I never committed to</tspan></text>
${iconRow(stats.touristForks, funTop + 60, suitcase)}

<line class="rule" x1="${LEFT}" x2="${WIDTH - LEFT}" y1="${sitesTop - 18}" y2="${sitesTop - 18}"/>
<text class="caps" x="${LEFT}" y="${sitesTop}">LIVE ON THE WEB</text>
${gatedNote}
${siteChips.svg}
</svg>
`;
}
