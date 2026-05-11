#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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
    .replace(/"/g, '&quot;');

const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');

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

const SPARK_CHARS = '▁▂▃▄▅▆▇█';
const sparkline = (values) => {
  if (!values?.length) return '';
  const max = Math.max(1, ...values);
  return values
    .map((v) => SPARK_CHARS[Math.min(SPARK_CHARS.length - 1, Math.floor((v / max) * SPARK_CHARS.length))])
    .join('');
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

const fetchOgImage = async (fullName) => {
  const res = await fetch(`https://github.com/${fullName}`, {
    headers: { 'User-Agent': USER },
    redirect: 'follow',
  });
  if (!res.ok) return null;
  const html = await res.text();
  const match = html.match(/<meta property="og:image" content="([^"]+)"/);
  return match?.[1] ?? null;
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
  const repoUrl = `https://github.com/${e.repo.name}`;
  switch (e.type) {
    case 'PushEvent': {
      const count = e.payload.distinct_size ?? e.payload.size ?? e.payload.commits?.length ?? 0;
      if (count === 0) return null;
      const branch = e.payload.ref?.replace('refs/heads/', '');
      return `Pushed ${count} commit${count > 1 ? 's' : ''}${branch ? ` to <code>${escape(branch)}</code>` : ''} <sub>${ago}</sub>`;
    }
    case 'PullRequestEvent': {
      const pr = e.payload.pull_request;
      const action = e.payload.action === 'closed' && pr.merged ? 'Merged' : capitalize(e.payload.action);
      return `${action} PR <a href="${repoUrl}/pull/${pr.number}">#${pr.number}</a> <sub>${ago}</sub>`;
    }
    case 'PullRequestReviewEvent': {
      const n = e.payload.pull_request.number;
      return `Reviewed PR <a href="${repoUrl}/pull/${n}">#${n}</a> <sub>${ago}</sub>`;
    }
    case 'ReleaseEvent': {
      const r = e.payload.release;
      const url = r.html_url ?? `${repoUrl}/releases/tag/${r.tag_name}`;
      return `Released <a href="${url}">${escape(r.tag_name)}</a> <sub>${ago}</sub>`;
    }
    case 'CreateEvent': {
      if (e.payload.ref_type === 'tag') return `Tagged <code>${escape(e.payload.ref)}</code> <sub>${ago}</sub>`;
      if (e.payload.ref_type === 'branch') return `Created branch <code>${escape(e.payload.ref)}</code> <sub>${ago}</sub>`;
      if (e.payload.ref_type === 'repository') return `Created the repository <sub>${ago}</sub>`;
      return null;
    }
    case 'IssuesEvent': {
      const i = e.payload.issue;
      return `${capitalize(e.payload.action)} issue <a href="${repoUrl}/issues/${i.number}">#${i.number}</a> <sub>${ago}</sub>`;
    }
    case 'IssueCommentEvent': {
      const i = e.payload.issue;
      const kind = i.pull_request ? 'PR' : 'issue';
      const path = i.pull_request ? 'pull' : 'issues';
      return `Commented on ${kind} <a href="${repoUrl}/${path}/${i.number}">#${i.number}</a> <sub>${ago}</sub>`;
    }
    default:
      return null;
  }
};

const pickEvents = (events) => {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    const line = formatRepoEvent(e);
    if (!line) continue;
    const key = line.replace(/<sub>.*?<\/sub>/, '').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= EVENTS_PER_CARD) break;
  }
  return out;
};

const renderCard = ({ repo, ogImage, participation, events }) => {
  const ownerCommits = participation?.owner ?? [];
  const spark = sparkline(ownerCommits);
  const totalYear = ownerCommits.reduce((a, b) => a + b, 0);
  const lastPush = relativeTime(repo.pushed_at);
  const lines = pickEvents(events);
  const eventList = lines.length
    ? `<ul>\n${lines.map((l) => `        <li>${l}</li>`).join('\n')}\n      </ul>`
    : '<sub><em>No recent activity</em></sub>';

  const ogSrc = ogImage ?? `https://opengraph.githubassets.com/${Date.now()}/${repo.full_name}`;
  const desc = repo.description ? `<sub>${escape(repo.description)}</sub><br/>` : '';
  const sparkBlock = spark
    ? `<code>${spark}</code> &nbsp; <sub>${totalYear} commits / 52w</sub> &nbsp; · &nbsp; `
    : '';

  return `<table>
  <tr>
    <td width="45%" valign="top">
      <a href="${escape(repo.html_url)}"><img src="${escape(ogSrc)}" alt="${escape(repo.name)}" width="100%" /></a>
    </td>
    <td valign="top">
      <h3>★ ${repo.stargazers_count.toLocaleString()} &nbsp; <a href="${escape(repo.html_url)}">${escape(repo.name)}</a></h3>
      ${desc}${sparkBlock}<sub>pushed ${lastPush}</sub>
      ${eventList}
    </td>
  </tr>
</table>`;
};

const replaceMarker = (text, section, content) => {
  const start = `<!-- ${section}:start -->`;
  const end = `<!-- ${section}:end -->`;
  const re = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (!re.test(text)) throw new Error(`marker not found: ${section}`);
  return text.replace(re, `${start}\n${content}\n${end}`);
};

const repos = await fetchTopRepos();
console.log(`Repos: ${repos.map((r) => r.name).join(', ')}`);

const enriched = await Promise.all(
  repos.map(async (repo) => {
    const [ogImage, participation, events] = await Promise.all([
      fetchOgImage(repo.full_name),
      fetchParticipation(repo.full_name),
      fetchRepoEvents(repo.full_name),
    ]);
    console.log(`  ${repo.name}: og=${ogImage ? 'ok' : 'fallback'}, participation=${participation ? 'ok' : 'n/a'}, events=${events.length}`);
    return { repo, ogImage, participation, events };
  }),
);

const featuredHtml = enriched.map(renderCard).join('\n');

const readmePath = resolve(REPO_ROOT, 'README.md');
let readme = await readFile(readmePath, 'utf8');
readme = replaceMarker(readme, 'featured', featuredHtml);
await writeFile(readmePath, readme);

console.log('Done.');
