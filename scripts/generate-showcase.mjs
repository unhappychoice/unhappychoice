#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const USER = 'unhappychoice';
const FEATURED_COUNT = 5;
const ACTIVITY_COUNT = 6;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const headers = () => {
  const h = { 'User-Agent': USER, Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
};

const escape = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');

const relativeTime = (iso) => {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  const d = Math.floor(diff / 86400);
  if (d >= 30) return `${Math.floor(d / 30)}mo ago`;
  if (d >= 7) return `${Math.floor(d / 7)}w ago`;
  if (d >= 1) return `${d}d ago`;
  const h = Math.floor(diff / 3600);
  if (h >= 1) return `${h}h ago`;
  const m = Math.floor(diff / 60);
  return m >= 1 ? `${m}m ago` : 'just now';
};

const fetchTopRepos = async () => {
  const res = await fetch(
    `https://api.github.com/users/${USER}/repos?per_page=100&type=owner&sort=updated`,
    { headers: headers() },
  );
  if (!res.ok) throw new Error(`repos ${res.status}: ${await res.text()}`);
  const repos = await res.json();
  return repos
    .filter((r) => !r.fork && !r.archived && !r.private && r.name !== USER)
    .sort((a, b) => b.stargazers_count - a.stargazers_count)
    .slice(0, FEATURED_COUNT);
};

const fetchEvents = async () => {
  const res = await fetch(
    `https://api.github.com/users/${USER}/events/public?per_page=100`,
    { headers: headers() },
  );
  if (!res.ok) throw new Error(`events ${res.status}: ${await res.text()}`);
  return res.json();
};

const fetchContributions = async () => {
  if (!process.env.GITHUB_TOKEN) {
    console.warn('No GITHUB_TOKEN — skipping contribution heatmap');
    return null;
  }
  const query = `query {
    user(login: "${USER}") {
      contributionsCollection {
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays { contributionCount date weekday }
          }
        }
      }
    }
  }`;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`graphql ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`graphql errors: ${JSON.stringify(json.errors)}`);
  return json.data.user.contributionsCollection.contributionCalendar;
};

const renderFeatured = (repos) => {
  const ts = Math.floor(Date.now() / 1000);
  const og = (r) => `https://opengraph.githubassets.com/${ts}/${r.full_name}`;
  const link = (r, img) =>
    `<a href="${escape(r.html_url)}" title="${escape(r.name)}">${img}</a>`;
  const hero = repos[0];
  const rest = repos.slice(1, 5);

  const heroImg = `<img src="${og(hero)}" alt="${escape(hero.name)}" width="100%" />`;
  const subCells = rest
    .map((r) => `    <td align="center" width="25%">${link(r, `<img src="${og(r)}" alt="${escape(r.name)}" width="100%" />`)}</td>`)
    .join('\n');

  return `<table>
  <tr>
    <td align="center" colspan="4">${link(hero, heroImg)}</td>
  </tr>
  <tr>
${subCells}
  </tr>
</table>`;
};

const formatEvent = (e) => {
  const ago = relativeTime(e.created_at);
  const repo = e.repo.name;
  const repoUrl = `https://github.com/${repo}`;
  const link = (text, url) => `[${text}](${url})`;
  const prUrl = (n) => `${repoUrl}/pull/${n}`;
  const issueUrl = (n) => `${repoUrl}/issues/${n}`;
  switch (e.type) {
    case 'PushEvent': {
      const count = e.payload.distinct_size ?? e.payload.size ?? e.payload.commits?.length ?? 0;
      if (count === 0) return null;
      return `- Pushed ${count} commit${count > 1 ? 's' : ''} to ${link(repo, repoUrl)} — *${ago}*`;
    }
    case 'PullRequestEvent': {
      const pr = e.payload.pull_request;
      const action = e.payload.action === 'closed' && pr.merged ? 'merged' : e.payload.action;
      return `- ${capitalize(action)} PR ${link(`#${pr.number}`, prUrl(pr.number))} in ${link(repo, repoUrl)} — *${ago}*`;
    }
    case 'ReleaseEvent': {
      const r = e.payload.release;
      const url = r.html_url ?? `${repoUrl}/releases/tag/${r.tag_name}`;
      return `- Released ${link(r.tag_name, url)} in ${link(repo, repoUrl)} — *${ago}*`;
    }
    case 'WatchEvent':
      return `- Starred ${link(repo, repoUrl)} — *${ago}*`;
    case 'CreateEvent':
      if (e.payload.ref_type === 'repository') {
        return `- Created repository ${link(repo, repoUrl)} — *${ago}*`;
      }
      return null;
    case 'IssuesEvent': {
      const i = e.payload.issue;
      return `- ${capitalize(e.payload.action)} issue ${link(`#${i.number}`, issueUrl(i.number))} in ${link(repo, repoUrl)} — *${ago}*`;
    }
    case 'PullRequestReviewEvent': {
      const n = e.payload.pull_request.number;
      return `- Reviewed PR ${link(`#${n}`, prUrl(n))} in ${link(repo, repoUrl)} — *${ago}*`;
    }
    default:
      return null;
  }
};

const renderActivity = (events) => {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    const line = formatEvent(e);
    if (!line) continue;
    const key = line.split(' — ')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= ACTIVITY_COUNT) break;
  }
  return out.join('\n');
};

const HEATMAP_THEMES = {
  light: {
    bg: '#ffffff',
    text: '#1f2328',
    muted: '#59636e',
    scale: ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'],
  },
  dark: {
    bg: '#0d1117',
    text: '#e6edf3',
    muted: '#8d96a0',
    scale: ['#161b22', '#0e4429', '#006d32', '#26a641', '#39d353'],
  },
};

const renderHeatmap = (cal, themeName) => {
  const t = HEATMAP_THEMES[themeName];
  const cell = 11;
  const gap = 3;
  const padLeft = 30;
  const padTop = 36;
  const padRight = 16;
  const padBottom = 28;

  const weeks = cal.weeks;
  const max = Math.max(1, ...weeks.flatMap((w) => w.contributionDays.map((d) => d.contributionCount)));
  const bucket = (c) => {
    if (c === 0) return 0;
    const r = c / max;
    if (r <= 0.25) return 1;
    if (r <= 0.5) return 2;
    if (r <= 0.75) return 3;
    return 4;
  };

  const width = padLeft + weeks.length * (cell + gap) - gap + padRight;
  const height = padTop + 7 * (cell + gap) - gap + padBottom;
  const font = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

  const months = [];
  let lastMonth = -1;
  weeks.forEach((wk, x) => {
    const first = wk.contributionDays[0];
    if (!first) return;
    const m = new Date(first.date).getUTCMonth();
    if (m !== lastMonth && x > 0 && x < weeks.length - 2) {
      const label = new Date(first.date).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
      months.push(
        `<text x="${padLeft + x * (cell + gap)}" y="${padTop - 10}" font-family="${font}" font-size="10" fill="${t.muted}">${label}</text>`,
      );
      lastMonth = m;
    } else if (lastMonth === -1) {
      lastMonth = m;
    }
  });

  const dayLabels = [
    { y: 1, label: 'Mon' },
    { y: 3, label: 'Wed' },
    { y: 5, label: 'Fri' },
  ]
    .map(
      ({ y, label }) =>
        `<text x="${padLeft - 8}" y="${padTop + y * (cell + gap) + cell - 1}" font-family="${font}" font-size="10" fill="${t.muted}" text-anchor="end">${label}</text>`,
    )
    .join('');

  const cells = weeks
    .flatMap((wk, x) =>
      wk.contributionDays.map((d) => {
        const cx = padLeft + x * (cell + gap);
        const cy = padTop + d.weekday * (cell + gap);
        return `<rect x="${cx}" y="${cy}" width="${cell}" height="${cell}" rx="2" ry="2" fill="${t.scale[bucket(d.contributionCount)]}"><title>${d.contributionCount} on ${d.date}</title></rect>`;
      }),
    )
    .join('');

  const legendY = height - 16;
  const legendX = width - padRight - (5 * (cell + gap) - gap) - 32;
  const legendCells = t.scale
    .map(
      (c, i) =>
        `<rect x="${legendX + 28 + i * (cell + gap)}" y="${legendY - cell + 2}" width="${cell}" height="${cell}" rx="2" ry="2" fill="${c}" />`,
    )
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Contribution heatmap">
  <rect width="${width}" height="${height}" fill="${t.bg}" />
  <text x="${padLeft - 22}" y="20" font-family="${font}" font-size="13" font-weight="600" fill="${t.text}">${cal.totalContributions.toLocaleString()} contributions in the last year</text>
  ${months.join('\n  ')}
  ${dayLabels}
  ${cells}
  <text x="${legendX}" y="${legendY}" font-family="${font}" font-size="10" fill="${t.muted}">Less</text>
  ${legendCells}
  <text x="${legendX + 28 + 5 * (cell + gap)}" y="${legendY}" font-family="${font}" font-size="10" fill="${t.muted}">More</text>
</svg>
`;
};

const replaceMarker = (text, section, content) => {
  const start = `<!-- ${section}:start -->`;
  const end = `<!-- ${section}:end -->`;
  const re = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (!re.test(text)) throw new Error(`marker not found: ${section}`);
  return text.replace(re, `${start}\n${content}\n${end}`);
};

const repos = await fetchTopRepos();
const events = await fetchEvents();
const cal = await fetchContributions();

const featuredHtml = renderFeatured(repos);
const activityMd = renderActivity(events);

if (cal) {
  await writeFile(resolve(REPO_ROOT, 'showcase.svg'), renderHeatmap(cal, 'light'));
  await writeFile(resolve(REPO_ROOT, 'showcase-dark.svg'), renderHeatmap(cal, 'dark'));
}

const readmePath = resolve(REPO_ROOT, 'README.md');
let readme = await readFile(readmePath, 'utf8');
readme = replaceMarker(readme, 'featured', featuredHtml);
readme = replaceMarker(readme, 'activity', activityMd);
await writeFile(readmePath, readme);

console.log(`Featured: ${repos.map((r) => r.name).join(', ')}`);
console.log(`Activity: ${activityMd.split('\n').length} events`);
console.log(`Heatmap: ${cal ? `${cal.totalContributions} contributions` : 'skipped'}`);
