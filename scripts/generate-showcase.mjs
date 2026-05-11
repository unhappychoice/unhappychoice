#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Buffer } from 'node:buffer';

const USER = 'unhappychoice';
const FEATURED_COUNT = 5;
const EVENTS_PER_CARD = 4;
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

const fetchTopRepos = async () => {
  const repos = await fetchJson(
    `https://api.github.com/users/${USER}/repos?per_page=100&type=owner&sort=updated`,
  );
  return repos
    .filter((r) => !r.fork && !r.archived && !r.private && r.name !== USER)
    .sort((a, b) => b.stargazers_count - a.stargazers_count)
    .slice(0, FEATURED_COUNT);
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

const fetchParticipation = async (fullName) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await fetchJson(`https://api.github.com/repos/${fullName}/stats/participation`);
      if (data._computing) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      return data;
    } catch (e) {
      console.warn(`participation ${fullName}: ${e.message}`);
      return null;
    }
  }
  return null;
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
    spark: '#0969da',
    sparkFill: 'rgba(9, 105, 218, 0.15)',
    placeholder: '#eaeef2',
  },
  dark: {
    bg: '#0d1117',
    text: '#e6edf3',
    muted: '#8d96a0',
    title: '#58a6ff',
    star: '#e3b341',
    spark: '#58a6ff',
    sparkFill: 'rgba(88, 166, 255, 0.22)',
    placeholder: '#21262d',
  },
};

const CARD_W = 800;
const CARD_H = 200;
const CARD_GAP = 14;
const PAD_OUT = 14;
const HEADER_H = 36;

const OG_X = 12;
const OG_Y = 12;
const OG_W = 360;
const OG_H = 176;

const INFO_X = OG_X + OG_W + 18;
const INFO_W = CARD_W - INFO_X - 14;

const renderSparkline = (values, x, y, w, h, theme) => {
  if (!values?.length) return '';
  const max = Math.max(1, ...values);
  const stepX = w / Math.max(1, values.length - 1);
  const pts = values.map((v, i) => {
    const px = x + i * stepX;
    const py = y + h - (v / max) * h;
    return `${px.toFixed(2)},${py.toFixed(2)}`;
  });
  const lastX = x + w;
  const area = `M ${pts.join(' L ')} L ${lastX.toFixed(2)},${(y + h).toFixed(2)} L ${x.toFixed(2)},${(y + h).toFixed(2)} Z`;
  return `<path d="${area}" fill="${theme.sparkFill}" />
    <polyline points="${pts.join(' ')}" fill="none" stroke="${theme.spark}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />`;
};

const renderCard = (i, { repo, og, participation, events }, theme) => {
  const evs = pickEvents(events);
  const ownerCommits = participation?.owner ?? [];
  const totalCommits = ownerCommits.reduce((a, b) => a + b, 0);
  const clipId = `og-${i}-${theme === THEMES.dark ? 'd' : 'l'}`;

  const titleY = 28;
  const sparkY = titleY + 14;
  const sparkH = 28;
  const sparkW = INFO_W * 0.62;
  const statsY = sparkY + sparkH + 16;
  const eventsStartY = statsY + 18;
  const eventLineH = 16;

  const ogBlock = og
    ? `<defs><clipPath id="${clipId}"><rect x="${OG_X}" y="${OG_Y}" width="${OG_W}" height="${OG_H}" rx="6" ry="6" /></clipPath></defs>
    <image x="${OG_X}" y="${OG_Y}" width="${OG_W}" height="${OG_H}" href="${og}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})" />`
    : `<rect x="${OG_X}" y="${OG_Y}" width="${OG_W}" height="${OG_H}" rx="6" ry="6" fill="${theme.placeholder}" />
    <text x="${OG_X + OG_W / 2}" y="${OG_Y + OG_H / 2}" font-family="${FONT}" font-size="13" fill="${theme.muted}" text-anchor="middle" dominant-baseline="middle">${escape(repo.name)}</text>`;

  const sparkBlock = ownerCommits.some((v) => v > 0)
    ? renderSparkline(ownerCommits, INFO_X, sparkY, sparkW, sparkH, theme)
    : `<text x="${INFO_X}" y="${sparkY + sparkH / 2 + 4}" font-family="${FONT}" font-size="10" fill="${theme.muted}">no commits in last 52 weeks</text>`;

  const eventBlock = evs.length
    ? evs
        .map((e, idx) => {
          const ey = eventsStartY + idx * eventLineH;
          return `<text x="${INFO_X}" y="${ey}" font-family="${FONT}" font-size="11" fill="${theme.text}">• ${escape(truncate(e.text, 44))}</text>
    <text x="${INFO_X + INFO_W}" y="${ey}" font-family="${FONT}" font-size="10" fill="${theme.muted}" text-anchor="end">${escape(e.ago)}</text>`;
        })
        .join('\n    ')
    : `<text x="${INFO_X}" y="${eventsStartY}" font-family="${FONT}" font-size="11" fill="${theme.muted}" font-style="italic">No recent activity</text>`;

  return `<g transform="translate(0, ${i * (CARD_H + CARD_GAP)})">
    ${ogBlock}
    <text x="${INFO_X}" y="${titleY}" font-family="${FONT}" font-size="16" font-weight="700" fill="${theme.title}">${escape(repo.name)}</text>
    <text x="${INFO_X + INFO_W}" y="${titleY}" font-family="${FONT}" font-size="13" font-weight="600" fill="${theme.star}" text-anchor="end">★ ${repo.stargazers_count.toLocaleString()}</text>
    ${sparkBlock}
    <text x="${INFO_X + INFO_W}" y="${sparkY + sparkH / 2 + 4}" font-family="${FONT}" font-size="10" fill="${theme.muted}" text-anchor="end">${totalCommits.toLocaleString()} commits / 52w</text>
    <text x="${INFO_X}" y="${statsY}" font-family="${FONT}" font-size="11" fill="${theme.muted}">pushed ${relativeTime(repo.pushed_at)}</text>
    ${eventBlock}
  </g>`;
};

const render = (cards, themeName) => {
  const theme = THEMES[themeName];
  const W = CARD_W + PAD_OUT * 2;
  const H = HEADER_H + PAD_OUT + cards.length * (CARD_H + CARD_GAP) - CARD_GAP + PAD_OUT;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Featured Projects">
  <rect width="${W}" height="${H}" fill="${theme.bg}" />
  <text x="${PAD_OUT}" y="${PAD_OUT + 18}" font-family="${FONT}" font-size="16" font-weight="700" fill="${theme.text}">Featured Projects</text>
  <text x="${W - PAD_OUT}" y="${PAD_OUT + 18}" text-anchor="end" font-family="${FONT}" font-size="11" fill="${theme.muted}">@${USER}</text>
  <g transform="translate(${PAD_OUT}, ${HEADER_H + PAD_OUT})">
    ${cards.map((c, i) => renderCard(i, c, theme)).join('\n    ')}
  </g>
</svg>
`;
};

const repos = await fetchTopRepos();
console.log(`Repos: ${repos.map((r) => r.name).join(', ')}`);

const enriched = await Promise.all(
  repos.map(async (repo) => {
    const [og, participation, events] = await Promise.all([
      fetchOgDataUri(repo.full_name),
      fetchParticipation(repo.full_name),
      fetchRepoEvents(repo.full_name),
    ]);
    console.log(
      `  ${repo.name}: og=${og ? `${Math.round(og.length / 1024)}KB` : 'fallback'}, participation=${participation ? 'ok' : 'n/a'}, events=${events.length}`,
    );
    return { repo, og, participation, events };
  }),
);

const lightSvg = render(enriched, 'light');
const darkSvg = render(enriched, 'dark');

await writeFile(resolve(REPO_ROOT, 'showcase.svg'), lightSvg);
await writeFile(resolve(REPO_ROOT, 'showcase-dark.svg'), darkSvg);

console.log(
  `Wrote showcase.svg (${Math.round(lightSvg.length / 1024)}KB), showcase-dark.svg (${Math.round(darkSvg.length / 1024)}KB)`,
);
