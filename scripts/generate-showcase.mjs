#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Buffer } from 'node:buffer';

const USER = 'unhappychoice';
const EVENTS_PER_CARD = 4;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

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
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');

const truncate = (s, n) => {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

const relativeTime = (iso) => {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  const d = Math.floor(diff / 86400);
  if (d >= 365) return `${Math.floor(d / 365)}y ago`;
  if (d >= 30) return `${Math.floor(d / 30)}mo ago`;
  if (d >= 7) return `${Math.floor(d / 7)}w ago`;
  if (d >= 1) return `${d}d ago`;
  const h = Math.floor(diff / 3600);
  if (h >= 1) return `${h}h ago`;
  const m = Math.floor(diff / 60);
  return m >= 1 ? `${m}m ago` : 'just now';
};

const fetchJson = async (url) => {
  const res = await fetch(url, { headers: headers() });
  if (res.status === 202) return { _computing: true };
  if (!res.ok) throw new Error(`${url} -> ${res.status}: ${await res.text()}`);
  return res.json();
};

const loadFeaturedConfig = async () => {
  const text = await readFile(resolve(SCRIPT_DIR, 'featured.json'), 'utf8');
  return JSON.parse(text);
};

const normalizeEntry = (entry) => {
  if (typeof entry === 'string') return { name: entry, link: null };
  return { name: entry.name, link: entry.link ?? null };
};

const fetchRepo = async (name) => {
  const fullName = name.includes('/') ? name : `${USER}/${name}`;
  return fetchJson(`https://api.github.com/repos/${fullName}`);
};

const fetchOgDataUri = async (fullName) => {
  try {
    const htmlRes = await fetch(`https://github.com/${fullName}`, {
      headers: { 'User-Agent': USER },
    });
    if (!htmlRes.ok) return null;
    const html = await htmlRes.text();
    const url = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1];
    if (!url) return null;
    const imgRes = await fetch(url);
    if (!imgRes.ok) return null;
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const mime = imgRes.headers.get('content-type') || 'image/png';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch (e) {
    console.warn(`og ${fullName}: ${e.message}`);
    return null;
  }
};

const DAY_MS = 86400 * 1000;
const GRASS_DAYS = 364;

const fetchDailyCommits = async (fullName) => {
  const since = new Date(Date.now() - GRASS_DAYS * DAY_MS).toISOString();
  const counts = Object.create(null);
  for (let page = 1; page <= 30; page++) {
    try {
      const commits = await fetchJson(
        `https://api.github.com/repos/${fullName}/commits?author=${USER}&since=${since}&per_page=100&page=${page}`,
      );
      if (!Array.isArray(commits) || commits.length === 0) break;
      for (const c of commits) {
        const date = c.commit?.author?.date?.slice(0, 10);
        if (date) counts[date] = (counts[date] ?? 0) + 1;
      }
      if (commits.length < 100) break;
    } catch (e) {
      console.warn(`commits ${fullName} page ${page}: ${e.message}`);
      break;
    }
  }
  return counts;
};

const buildGrassGrid = (dateCounts) => {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayDow = today.getUTCDay();
  const start = new Date(today);
  start.setUTCDate(today.getUTCDate() - todayDow - 51 * 7);
  const grid = Array.from({ length: 52 }, () => Array(7).fill(0));
  for (let col = 0; col < 52; col++) {
    for (let row = 0; row < 7; row++) {
      const date = new Date(start);
      date.setUTCDate(start.getUTCDate() + col * 7 + row);
      if (date > today) continue;
      const key = date.toISOString().slice(0, 10);
      grid[col][row] = dateCounts[key] ?? 0;
    }
  }
  return grid;
};

const fetchRepoEvents = async (fullName) => {
  try {
    const events = await fetchJson(`https://api.github.com/repos/${fullName}/events?per_page=50`);
    return events.filter((e) => e.actor?.login === USER);
  } catch (e) {
    console.warn(`events ${fullName}: ${e.message}`);
    return [];
  }
};

const formatRepoEvent = (e) => {
  const ago = relativeTime(e.created_at);
  switch (e.type) {
    case 'PushEvent': {
      const count = e.payload.distinct_size ?? e.payload.size ?? e.payload.commits?.length ?? 0;
      if (count === 0) return null;
      const branch = e.payload.ref?.replace('refs/heads/', '');
      return { text: `Pushed ${count} commit${count > 1 ? 's' : ''}${branch ? ` to ${branch}` : ''}`, ago };
    }
    case 'PullRequestEvent': {
      const pr = e.payload.pull_request;
      const action = e.payload.action === 'closed' && pr.merged ? 'Merged' : capitalize(e.payload.action);
      return { text: `${action} PR #${pr.number}`, ago };
    }
    case 'PullRequestReviewEvent':
      return { text: `Reviewed PR #${e.payload.pull_request.number}`, ago };
    case 'ReleaseEvent':
      return { text: `Released ${e.payload.release.tag_name}`, ago };
    case 'CreateEvent':
      if (e.payload.ref_type === 'tag') return { text: `Tagged ${e.payload.ref}`, ago };
      if (e.payload.ref_type === 'branch') return { text: `Created branch ${e.payload.ref}`, ago };
      if (e.payload.ref_type === 'repository') return { text: 'Created the repository', ago };
      return null;
    case 'IssuesEvent':
      return { text: `${capitalize(e.payload.action)} issue #${e.payload.issue.number}`, ago };
    case 'IssueCommentEvent': {
      const i = e.payload.issue;
      const kind = i.pull_request ? 'PR' : 'issue';
      return { text: `Commented on ${kind} #${i.number}`, ago };
    }
    default:
      return null;
  }
};

const pickEvents = (events) => {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    const f = formatRepoEvent(e);
    if (!f) continue;
    if (seen.has(f.text)) continue;
    seen.add(f.text);
    out.push(f);
    if (out.length >= EVENTS_PER_CARD) break;
  }
  return out;
};

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

const THEMES = {
  light: {
    bg: '#ffffff',
    text: '#1f2328',
    muted: '#59636e',
    title: '#0969da',
    star: '#bf8700',
    placeholder: '#eaeef2',
    grass: ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'],
  },
  dark: {
    bg: '#0d1117',
    text: '#e6edf3',
    muted: '#8d96a0',
    title: '#58a6ff',
    star: '#e3b341',
    placeholder: '#21262d',
    grass: ['#161b22', '#0e4429', '#006d32', '#26a641', '#39d353'],
  },
};

const CARD_W = 800;
const CARD_H = 200;
const CARD_GAP = 14;
const PAD_OUT = 8;

const OG_X = 12;
const OG_Y = 12;
const OG_W = 360;
const OG_H = 176;

const INFO_X = OG_X + OG_W + 18;
const INFO_W = CARD_W - INFO_X - 14;

const GRASS_CELL = 6;
const GRASS_GAP = 1;
const GRASS_WEEKS = 52;
const GRASS_W = GRASS_WEEKS * (GRASS_CELL + GRASS_GAP) - GRASS_GAP;
const GRASS_H = 7 * (GRASS_CELL + GRASS_GAP) - GRASS_GAP;

const renderGrass = (grid, x, y, theme) => {
  if (!grid?.length) return '';
  const allCounts = grid.flat();
  const max = Math.max(1, ...allCounts);
  const bucket = (c) => {
    if (c === 0) return 0;
    const r = c / max;
    if (r <= 0.25) return 1;
    if (r <= 0.5) return 2;
    if (r <= 0.75) return 3;
    return 4;
  };
  const step = GRASS_CELL + GRASS_GAP;
  return grid
    .flatMap((week, xi) =>
      week.map((count, yi) => {
        const cx = x + xi * step;
        const cy = y + yi * step;
        return `<rect x="${cx}" y="${cy}" width="${GRASS_CELL}" height="${GRASS_CELL}" rx="1.5" ry="1.5" fill="${theme.grass[bucket(count)]}" />`;
      }),
    )
    .join('');
};

const renderCard = (i, { repo, og, grass, totalCommits, events, link }, theme) => {
  const evs = pickEvents(events);
  const clipId = `og-${i}-${theme === THEMES.dark ? 'd' : 'l'}`;
  const href = link ?? repo.html_url;

  const titleY = 28;
  const grassY = titleY + 14;
  const statsY = grassY + GRASS_H + 20;
  const eventsStartY = statsY + 20;
  const eventLineH = 16;

  const ogBlock = og
    ? `<defs><clipPath id="${clipId}"><rect x="${OG_X}" y="${OG_Y}" width="${OG_W}" height="${OG_H}" rx="6" ry="6" /></clipPath></defs>
    <image x="${OG_X}" y="${OG_Y}" width="${OG_W}" height="${OG_H}" href="${og}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})" />`
    : `<rect x="${OG_X}" y="${OG_Y}" width="${OG_W}" height="${OG_H}" rx="6" ry="6" fill="${theme.placeholder}" />
    <text x="${OG_X + OG_W / 2}" y="${OG_Y + OG_H / 2}" font-family="${FONT}" font-size="13" fill="${theme.muted}" text-anchor="middle" dominant-baseline="middle">${escape(repo.name)}</text>`;

  const grassBlock = totalCommits > 0
    ? renderGrass(grass, INFO_X, grassY, theme)
    : `<text x="${INFO_X}" y="${grassY + GRASS_H / 2 + 4}" font-family="${FONT}" font-size="10" fill="${theme.muted}">no commits in last 52 weeks</text>`;

  const eventBlock = evs.length
    ? evs
        .map((e, idx) => {
          const ey = eventsStartY + idx * eventLineH;
          return `<text x="${INFO_X}" y="${ey}" font-family="${FONT}" font-size="11" fill="${theme.text}">• ${escape(truncate(e.text, 44))}</text>
    <text x="${INFO_X + INFO_W}" y="${ey}" font-family="${FONT}" font-size="10" fill="${theme.muted}" text-anchor="end">${escape(e.ago)}</text>`;
        })
        .join('\n    ')
    : `<text x="${INFO_X}" y="${eventsStartY}" font-family="${FONT}" font-size="11" fill="${theme.muted}" font-style="italic">No recent activity</text>`;

  return `<a href="${escape(href)}" target="_blank">
    <g transform="translate(0, ${i * (CARD_H + CARD_GAP)})">
      ${ogBlock}
      <text x="${INFO_X}" y="${titleY}" font-family="${FONT}" font-size="16" font-weight="700" fill="${theme.title}">${escape(repo.name)}</text>
      <text x="${INFO_X + INFO_W}" y="${titleY}" font-family="${FONT}" font-size="13" font-weight="600" fill="${theme.star}" text-anchor="end">★ ${repo.stargazers_count.toLocaleString()}</text>
      ${grassBlock}
      <text x="${INFO_X}" y="${statsY}" font-family="${FONT}" font-size="11" fill="${theme.muted}">${totalCommits.toLocaleString()} commits / 52w · pushed ${relativeTime(repo.pushed_at)}</text>
      ${eventBlock}
    </g>
  </a>`;
};

const renderOne = (card, themeName) => {
  const theme = THEMES[themeName];
  const W = CARD_W + PAD_OUT * 2;
  const H = CARD_H + PAD_OUT * 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escape(card.repo.name)}">
  <rect width="${W}" height="${H}" fill="${theme.bg}" />
  <g transform="translate(${PAD_OUT}, ${PAD_OUT})">
    ${renderCard(0, card, theme)}
  </g>
</svg>
`;
};

const renderReadmeBlock = (cards) => {
  const links = cards
    .map(({ repo, link }) => {
      const href = link ?? repo.html_url;
      const slug = repo.name;
      return `  <a href="${escape(href)}">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="./showcase-${slug}-dark.svg" />
      <source media="(prefers-color-scheme: light)" srcset="./showcase-${slug}.svg" />
      <img alt="${escape(slug)}" src="./showcase-${slug}.svg" />
    </picture>
  </a>`;
    })
    .join('\n');
  return `<div align="center">\n${links}\n</div>`;
};

const replaceMarker = (text, section, content) => {
  const start = `<!-- ${section}:start -->`;
  const end = `<!-- ${section}:end -->`;
  const re = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (!re.test(text)) throw new Error(`marker not found: ${section}`);
  return text.replace(re, `${start}\n${content}\n${end}`);
};

const config = await loadFeaturedConfig();
const entries = config.repos.map(normalizeEntry);
const repos = await Promise.all(entries.map((e) => fetchRepo(e.name)));
console.log(`Repos: ${repos.map((r) => r.name).join(', ')}`);

const enriched = await Promise.all(
  repos.map(async (repo, idx) => {
    const [og, dailyCounts, events] = await Promise.all([
      fetchOgDataUri(repo.full_name),
      fetchDailyCommits(repo.full_name),
      fetchRepoEvents(repo.full_name),
    ]);
    const grass = buildGrassGrid(dailyCounts);
    const totalCommits = Object.values(dailyCounts).reduce((a, b) => a + b, 0);
    console.log(
      `  ${repo.name}: og=${og ? `${Math.round(og.length / 1024)}KB` : 'fallback'}, commits=${totalCommits}, events=${events.length}`,
    );
    return { repo, og, grass, totalCommits, events, link: entries[idx].link };
  }),
);

for (const card of enriched) {
  const slug = card.repo.name;
  const lightSvg = renderOne(card, 'light');
  const darkSvg = renderOne(card, 'dark');
  await writeFile(resolve(REPO_ROOT, `showcase-${slug}.svg`), lightSvg);
  await writeFile(resolve(REPO_ROOT, `showcase-${slug}-dark.svg`), darkSvg);
  console.log(`  wrote showcase-${slug}.svg (${Math.round(lightSvg.length / 1024)}KB)`);
}

const readmePath = resolve(REPO_ROOT, 'README.md');
let readme = await readFile(readmePath, 'utf8');
readme = replaceMarker(readme, 'featured', renderReadmeBlock(enriched));
await writeFile(readmePath, readme);
console.log('updated README.md');
