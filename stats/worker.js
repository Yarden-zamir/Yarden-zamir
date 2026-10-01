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
// The free Workers plan allows 50 subrequests per run. Budget today: about 4 for GitHub,
// 2 + one per zone for Cloudflare, CERT_REQUESTS_PER_RUN for certificate logs, and
// SITE_CHECKS_PER_RUN site checks that rotate through all hosts.
// Limit: about 10 more zones or 400 more repos fit. Revisit when a run hits the limit.
const SITE_CHECKS_PER_RUN = 22;
const CERT_REQUESTS_PER_RUN = 6;
const SITE_LOOKBACK_DAYS = 7;
// Hosts that stay off the profile. Each entry hides that host and all its subdomains.
const HIDDEN = ["example.yarden-zamir.com", "shahar-zamir.com"];
const isHidden = (host) => HIDDEN.some((h) => host === h || host.endsWith(`.${h}`));
// The README holds this many site slots: /site/<n>.svg draws slot n, /go/<n> opens it.
// An image inside an <img> cannot hold links, so each site is its own linked image.
// Limit: live sites beyond this count are not shown. Revisit when the list outgrows it.
const SITE_SLOTS = 20;
const PROFILE_URL = `https://github.com/${LOGIN}`;

export default {
  async fetch(request, env) {
    const snapshot = await env.STATS.get("snapshot", "json");
    if (!snapshot) return new Response("The first cron run has not finished yet", { status: 503 });
    // Hide right away, without waiting for the next cron run to rebuild the list.
    snapshot.sites.live = snapshot.sites.live.filter((site) => !isHidden(site.host));

    const [, route = "", slotName = ""] = new URL(request.url).pathname.split("/");
    if (route === "") return svgResponse(renderCard(snapshot));

    const slot = Number(slotName.endsWith(".svg") ? slotName.slice(0, -4) : slotName);
    if (!Number.isInteger(slot) || slot < 0 || slot >= SITE_SLOTS) return new Response("Not found", { status: 404 });
    const site = snapshot.sites.live[slot];
    if (route === "site") return svgResponse(site ? renderChip(site) : EMPTY_SVG);
    if (route === "go") return Response.redirect(site ? `https://${site.host}/` : PROFILE_URL, 302);
    return new Response("Not found", { status: 404 });
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
  if (zones.length === 50) throw new Error("50 or more zones: paginate the zone list");
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

  // Skip wildcards, service records, pull request previews and hidden hosts.
  const usable = [...hosts].filter((h) => !h.includes("*") && !h.startsWith("_") && !h.startsWith("pr.") && !isHidden(h));
  return { zones: zones.map((z) => z.name), hosts: usable };
}

// ---------- Certificate dates ----------

// The first TLS certificate of a host is the best public record of when the site went
// live. Two certificate transparency sources fill one table of earliest dates in KV:
// - Cert Spotter, every run, from a stored cursor per zone. It returns only unexpired
//   certificates, so it catches every new host but not old history.
// - crt.sh, once per zone, for the full history. It often fails, so each run retries one
//   zone that has no history yet.
// Both are optional enrichment: a failure is logged and the card still refreshes.
async function refreshCertDates(env, zones) {
  const certs = (await env.STATS.get("certs", "json")) ?? { first: {}, cursors: {}, history: {} };
  const record = (name, date) => {
    if (name.startsWith("*.")) return;
    const iso = new Date(date.endsWith("Z") ? date : `${date}Z`).toISOString();
    if (!certs.first[name] || iso < certs.first[name]) certs.first[name] = iso;
  };
  let budget = CERT_REQUESTS_PER_RUN;

  const historyZone = zones.find((z) => !certs.history[z]);
  if (historyZone) {
    budget--;
    try {
      const response = await fetch(`https://crt.sh/?q=${encodeURIComponent(`%.${historyZone}`)}&output=json`, { signal: AbortSignal.timeout(25000) });
      if (!response.ok) throw new Error(`crt.sh returned ${response.status}`);
      for (const entry of await response.json()) for (const name of entry.name_value.split("\n")) record(name.toLowerCase(), entry.not_before);
      certs.history[historyZone] = true;
    } catch (error) {
      console.error(`crt.sh history for ${historyZone} failed, retrying next run: ${error}`);
    }
  }

  certSpotter: for (const zone of zones) {
    for (let more = true; more; ) {
      if (budget-- <= 0) break certSpotter;
      const after = certs.cursors[zone] ? `&after=${certs.cursors[zone]}` : "";
      const response = await fetch(`https://api.certspotter.com/v1/issuances?domain=${zone}&include_subdomains=true&expand=dns_names${after}`);
      if (response.status === 429) { console.error("Cert Spotter rate limit reached, continuing next run"); break certSpotter; }
      if (!response.ok) { console.error(`Cert Spotter ${zone} returned ${response.status}`); break; }
      const issuances = await response.json();
      for (const issuance of issuances) for (const name of issuance.dns_names) record(name.toLowerCase(), issuance.not_before);
      if (issuances.length) certs.cursors[zone] = issuances.at(-1).id;
      more = (response.headers.get("Link") ?? "").includes('rel="next"');
    }
  }

  await env.STATS.put("certs", JSON.stringify(certs));
  return certs.first;
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
  const { zones, hosts: found } = await candidateHosts(env.CLOUDFLARE_API_TOKEN);
  const previous = (await env.STATS.get("sites", "json")) ?? {};
  const now = new Date().toISOString();
  // State saved before firstLiveAt existed: date those live hosts from now.
  for (const s of Object.values(previous)) if (s.state === "public" && !s.firstLiveAt) s.firstLiveAt = now;
  // Keep every host that was ever live, even after a week without DNS lookups, so it
  // keeps its place and date.
  const everLive = Object.keys(previous).filter((h) => previous[h].firstLiveAt && !isHidden(h));
  const hosts = [...new Set([...found, ...everLive])];
  const state = Object.fromEntries(hosts.map((h) => [h, previous[h] ?? { checkedAt: 0 }]));

  const due = hosts.sort((a, b) => state[a].checkedAt - state[b].checkedAt).slice(0, SITE_CHECKS_PER_RUN);
  const [results, certDates] = await Promise.all([Promise.all(due.map(checkSite)), refreshCertDates(env, zones)]);
  due.forEach((host, i) => {
    const firstLiveAt = state[host].firstLiveAt ?? (results[i].state === "public" ? now : undefined);
    state[host] = { ...results[i], checkedAt: Date.now(), ...(firstLiveAt && { firstLiveAt }) };
  });
  await env.STATS.put("sites", JSON.stringify(state));
  // "born" holds dates set by hand, such as the creation date of the repo behind a site.
  // They win over certificate dates, which only bound when a site went live.
  const born = (await env.STATS.get("born", "json")) ?? {};
  const since = (host) => born[host] ?? certDates[host] ?? state[host].firstLiveAt;

  // One site often answers on several hosts (apex, www, an alias domain). Keep the
  // shortest host per page title.
  const byTitle = new Map();
  for (const [host, s] of Object.entries(state)) {
    if (s.state !== "public" || isHidden(host)) continue;
    const key = s.title || host;
    const kept = byTitle.get(key);
    const date = since(host);
    const earliest = kept && kept.since < date ? kept.since : date;
    if (!kept || host.length < kept.host.length) byTitle.set(key, { host, title: s.title ?? "", since: earliest });
    else kept.since = earliest;
  }
  return {
    // Newest first.
    live: [...byTitle.values()].sort((a, b) => b.since.localeCompare(a.since)),
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

const full = new Intl.NumberFormat("en");
const escapeXml = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

// The card is a printed receipt. Monospace ink, so text width is predictable:
// one character is about 0.6 of the font size.
const WIDTH = 440;
const PAD = 30;
const RIGHT = WIDTH - PAD;
const MONO = `ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
const CHAR = 0.6 * 13;

const STYLE = `
  text { font-family: ${MONO}; fill: var(--ink); }
  svg { --paper: #fbf8f1; --edge: #e6dfd2; --ink: #2a2622; --faded: #8c857a; --stamp: #c8402b; }
  @media (prefers-color-scheme: dark) {
    svg { --paper: #23221f; --edge: #3a3833; --ink: #ece4d6; --faded: #8f897e; --stamp: #f0694f; }
  }
  .paper { fill: var(--paper); stroke: var(--edge); }
  .faded { fill: var(--faded); }
  .ink { fill: var(--ink); }
  .rule { stroke: var(--faded); stroke-dasharray: 4 4; }
  .leader { stroke: var(--faded); stroke-width: 1.4; stroke-linecap: round; stroke-dasharray: 0.1 5; }
  .stamp { fill: none; stroke: var(--stamp); }
  .stamptext { fill: var(--stamp); font-weight: 800; }
  .line { animation: print 260ms steps(4) both; }
  @keyframes print { from { opacity: 0; transform: translateY(-3px); } }
  @media (prefers-reduced-motion: reduce) { .line { animation: none; } }
`;

// Torn paper: a zigzag along the top and bottom edges.
function receiptPath(height) {
  const tooth = 10;
  const depth = 5;
  const teeth = Math.ceil(WIDTH / tooth);
  let d = `M0 ${depth}`;
  for (let i = 0; i < teeth; i++) d += ` L${i * tooth + tooth / 2} 0 L${Math.min(WIDTH, (i + 1) * tooth)} ${depth}`;
  d += ` L${WIDTH} ${height - depth}`;
  for (let i = teeth - 1; i >= 0; i--) d += ` L${i * tooth + tooth / 2} ${height} L${i * tooth} ${height - depth}`;
  return `${d} Z`;
}

// Weekly contributions become a barcode: busier weeks print thicker bars.
function barcode(weekly, top) {
  const max = Math.max(1, ...weekly);
  const widths = weekly.map((w) => 1 + Math.round(Math.sqrt(w / max) * 4));
  const gap = 2;
  const total = widths.reduce((s, w) => s + w + gap, -gap);
  let x = (WIDTH - total) / 2;
  return widths.map((w) => {
    const bar = `<rect class="ink" x="${x.toFixed(1)}" y="${top}" width="${w}" height="46"/>`;
    x += w + gap;
    return bar;
  }).join("");
}

const tombstone = (x, y) => `<path class="faded" d="M${x} ${y + 13}v-8a3.5 3.5 0 0 1 7 0v8z"/><path d="M${x + 3.5} ${y + 4}v5M${x + 2} ${y + 5.5}h3" stroke="var(--paper)" stroke-width="1"/>`;
const suitcase = (x, y) => `<rect class="faded" x="${x}" y="${y + 4}" width="8" height="9" rx="1.5"/><path d="M${x + 2.5} ${y + 4}v-2h3v2" fill="none" stroke="var(--faded)" stroke-width="1.3"/>`;

function iconRow(count, top, draw) {
  const step = 10;
  const fits = Math.floor((RIGHT - PAD) / step);
  const shown = count > fits ? fits - 4 : count;
  const icons = Array.from({ length: shown }, (_, i) => draw(PAD + i * step, top)).join("");
  return count > shown ? `${icons}<text class="faded" x="${PAD + shown * step + 4}" y="${top + 12}" font-size="11">+${count - shown}</text>` : icons;
}

function renderCard({ stats, sites, updatedAt }) {
  const { level, percentile } = rank(stats);
  const top = Math.max(1, Math.round(percentile));
  const printed = new Date(updatedAt).toISOString().slice(0, 16).replace("T", " ");
  const lines = [];
  let y = 0;
  let delay = 0;
  const add = (svg, advance) => {
    y += advance;
    lines.push(`<g class="line" style="animation-delay:${(delay += 45)}ms">${svg(y)}</g>`);
  };
  const center = (text, cls, size, extra = "") => (ty) => `<text class="${cls}" x="${WIDTH / 2}" y="${ty}" font-size="${size}" text-anchor="middle" ${extra}>${text}</text>`;
  const rule = (ty) => `<line class="rule" x1="${PAD}" x2="${RIGHT}" y1="${ty}" y2="${ty}"/>`;
  const item = (label, value) => (ty) => {
    const v = full.format(value);
    const from = PAD + label.length * CHAR + 8;
    const to = RIGHT - v.length * CHAR - 8;
    return `<text x="${PAD}" y="${ty}" font-size="13">${label}</text><line class="leader" x1="${from}" x2="${to}" y1="${ty - 3}" y2="${ty - 3}"/><text x="${RIGHT}" y="${ty}" font-size="13" font-weight="700" text-anchor="end">${v}</text>`;
  };

  add(center(`${escapeXml(stats.name.toUpperCase())}`, "ink", 18, 'font-weight="800" letter-spacing="2"'), 44);
  add(center(`github.com/${LOGIN}`, "faded", 11.5), 18);
  add(center(`RECEIPT NO. ${stats.year} · PRINTED ${printed} UTC`, "faded", 10, 'letter-spacing="0.5"'), 16);
  add(rule, 18);

  add(center(full.format(stats.contributions), "ink", 40, 'font-weight="800"'), 52);
  add(center(`CONTRIBUTIONS IN ${stats.year}`, "faded", 11, 'letter-spacing="2"'), 20);
  add((ty) => barcode(stats.weekly, ty), 14);
  add(center(`* ${String(stats.contributions).padStart(7, "0")} ${stats.year} *`, "faded", 10, 'letter-spacing="4"'), 62);
  add(rule, 18);

  const items = [
    ["STARS EARNED", stats.stars],
    [`COMMITS ${stats.year}`, stats.commits],
    ["PULL REQUESTS", stats.prs],
    ["ISSUES", stats.issues],
    ["CONTRIBUTED TO", stats.contributedTo],
    ["RELEASES SHIPPED", stats.releases],
    [`NEW PROJECTS ${stats.year}`, stats.newProjects],
  ];
  items.forEach(([label, value], i) => add(item(label, value), i === 0 ? 28 : 23));
  const stampY = y - 80;
  add(rule, 22);

  add(item("GRAVEYARD", stats.graveyard), 26);
  add((ty) => `<text class="faded" x="${PAD}" y="${ty}" font-size="10.5">projects with no commit from me in 2+ years</text>`, 16);
  add((ty) => iconRow(stats.graveyard, ty, tombstone), 8);
  add(item("TOURIST FORKS", stats.touristForks), 36);
  add((ty) => `<text class="faded" x="${PAD}" y="${ty}" font-size="10.5">forked, looked around, never committed</text>`, 16);
  add((ty) => iconRow(stats.touristForks, ty, suitcase), 8);
  add(rule, 32);

  const gated = sites.gated ? ` · +${sites.gated} BEHIND A LOGIN` : "";
  add(center(`LIVE ON THE WEB: ${sites.live.length} SITES${gated}`, "ink", 11, 'font-weight="700" letter-spacing="1"'), 24);
  add(center("tear off a ticket below ✂", "faded", 10.5), 16);
  add(center("NO REFUNDS ON ABANDONED PROJECTS", "faded", 9.5, 'letter-spacing="1.5"'), 24);
  const height = y + 22;

  // A rubber stamp, slightly crooked, over the line items.
  const stamp = `<g transform="translate(${RIGHT - 92} ${stampY}) rotate(-13)" opacity="0.88">
    <circle class="stamp" r="40" stroke-width="2.5"/><circle class="stamp" r="34" stroke-width="1"/>
    <text class="stamptext" y="-15" font-size="9" text-anchor="middle" letter-spacing="2">GRADE</text>
    <text class="stamptext" y="13" font-size="30" text-anchor="middle">${level}</text>
    <text class="stamptext" y="27" font-size="8.5" text-anchor="middle" letter-spacing="1">TOP ${top}%</text>
  </g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-labelledby="title">
<title id="title">${escapeXml(stats.name)}'s GitHub receipt: ${full.format(stats.contributions)} contributions in ${stats.year}, grade ${level}</title>
<style>${STYLE}</style>
<path class="paper" d="${receiptPath(height)}"/>
${lines.join("\n")}
${stamp}
</svg>
`;
}

const EMPTY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';

function svgResponse(svg) {
  return new Response(svg, {
    headers: { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": `public, max-age=${CARD_CACHE_SECONDS}` },
  });
}

// A ticket stub per live site. The README links each one, because links inside an
// image do not work on GitHub.
function renderChip({ host, title, since }) {
  const label = host.startsWith("www.") ? host.slice(4) : host;
  const parts = label.split(".");
  const domain = parts.slice(-2).join(".");
  const sub = parts.slice(0, -2).join(".");
  const h = 30;
  const r = 5;
  const stub = 26;
  const w = Math.round(stub + 12 + label.length * 0.6 * 12 + 14);
  const text = sub ? `<tspan font-weight="700">${escapeXml(sub)}</tspan><tspan class="faded">.${escapeXml(domain)}</tspan>` : `<tspan font-weight="700">${escapeXml(domain)}</tspan>`;
  const ticket = `M3 0H${w - 3}Q${w} 0 ${w} 3V${h / 2 - r}A${r} ${r} 0 0 0 ${w} ${h / 2 + r}V${h - 3}Q${w} ${h} ${w - 3} ${h}H3Q0 ${h} 0 ${h - 3}V${h / 2 + r}A${r} ${r} 0 0 0 0 ${h / 2 - r}V3Q0 0 3 0Z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${escapeXml(title || label)}">
<title>${escapeXml(title || label)}</title>
<style>${STYLE}</style>
<path class="paper" d="${ticket}"/>
<line class="rule" x1="${stub}" x2="${stub}" y1="4" y2="${h - 4}" stroke-dasharray="2 3"/>
<text class="faded" x="${stub / 2 + 1}" y="${h / 2 + 3.5}" font-size="9.5" text-anchor="middle">${since ? `’${since.slice(2, 4)}` : "↗"}</text>
<text x="${stub + 12}" y="${h / 2 + 4}" font-size="12">${text}</text>
</svg>
`;
}
