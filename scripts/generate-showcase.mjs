#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';

const USER = 'unhappychoice';
const COUNT = 6;
const COLS = 2;
const CARD_W = 384;
const CARD_H = 96;
const GAP = 16;
const PAD = 16;
const HEADER_H = 48;

const THEMES = {
  light: {
    bg: '#ffffff',
    cardBg: '#f6f8fa',
    border: '#d0d7de',
    title: '#0969da',
    text: '#1f2328',
    muted: '#59636e',
    accent: '#bf8700',
  },
  dark: {
    bg: '#0d1117',
    cardBg: '#161b22',
    border: '#30363d',
    title: '#58a6ff',
    text: '#e6edf3',
    muted: '#8d96a0',
    accent: '#e3b341',
  },
};

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

const escape = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const truncate = (s, n) => {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

const fetchRepos = async () => {
  const headers = { 'User-Agent': USER };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const res = await fetch(
    `https://api.github.com/users/${USER}/repos?per_page=100&type=owner&sort=updated`,
    { headers },
  );
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const repos = await res.json();
  return repos
    .filter((r) => !r.fork && !r.archived && !r.private && r.name !== USER)
    .sort((a, b) => b.stargazers_count - a.stargazers_count)
    .slice(0, COUNT);
};

const renderCard = (repo, x, y, theme) => `
  <g transform="translate(${x}, ${y})">
    <rect width="${CARD_W}" height="${CARD_H}" rx="6" ry="6" fill="${theme.cardBg}" stroke="${theme.border}" />
    <text x="14" y="24" font-family="${FONT}" font-size="14" font-weight="600" fill="${theme.title}">${escape(repo.name)}</text>
    <text x="14" y="48" font-family="${FONT}" font-size="11" fill="${theme.text}">${escape(truncate(repo.description, 56))}</text>
    <g transform="translate(14, ${CARD_H - 14})" font-family="${FONT}" font-size="11" fill="${theme.muted}">
      <text>★ ${repo.stargazers_count}</text>
      <text x="56">${escape(repo.language ?? '')}</text>
    </g>
  </g>
`;

const render = (repos, themeName) => {
  const theme = THEMES[themeName];
  const rows = Math.ceil(repos.length / COLS);
  const innerW = CARD_W * COLS + GAP * (COLS - 1);
  const innerH = CARD_H * rows + GAP * (rows - 1);
  const W = innerW + PAD * 2;
  const H = innerH + PAD * 2 + HEADER_H;

  const cards = repos
    .map((r, i) => {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const x = PAD + col * (CARD_W + GAP);
      const y = PAD + HEADER_H + row * (CARD_H + GAP);
      return renderCard(r, x, y, theme);
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Featured Projects">
  <rect width="${W}" height="${H}" rx="8" fill="${theme.bg}" />
  <text x="${PAD}" y="${PAD + 22}" font-family="${FONT}" font-size="16" font-weight="700" fill="${theme.text}">Featured Projects</text>
  <text x="${W - PAD}" y="${PAD + 22}" text-anchor="end" font-family="${FONT}" font-size="11" fill="${theme.muted}">@${USER}</text>
  ${cards}
</svg>
`;
};

const repos = await fetchRepos();
await writeFile(new URL('../showcase.svg', import.meta.url), render(repos, 'light'));
await writeFile(new URL('../showcase-dark.svg', import.meta.url), render(repos, 'dark'));
console.log(`Generated showcase with ${repos.length} repos:`);
for (const r of repos) {
  console.log(`  ★${r.stargazers_count} ${r.name} (${r.language ?? '-'})`);
}
