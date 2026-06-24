import { readFileSync } from 'fs';

const html = readFileSync('trending.html', 'utf8');

// Each trending repo is in an <article class="Box-row">
const articleRe = /<article class="Box-row">([\s\S]*?)<\/article>/g;
let match;
let i = 1;

while ((match = articleRe.exec(html)) !== null) {
  const block = match[1];

  // Repo name from h2
  const h2Match = block.match(/<h2 class="h3 lh-condensed">([\s\S]*?)<\/h2>/);
  const h2Block = h2Match ? h2Match[1] : '';
  const hrefMatch = h2Block.match(/href="\/([^"]+)"/);
  const repo = hrefMatch ? hrefMatch[1] : '?';

  // Description from <p class="col-9 color-fg-muted...">
  const descMatch = block.match(/<p class="col-9[\s\S]*?">([\s\S]*?)<\/p>/);
  let desc = descMatch ? descMatch[1].replace(/<[^>]+>/g, '').trim() : '';

  // Language
  const langMatch = block.match(/itemprop="programmingLanguage">([^<]+)</);
  const lang = langMatch ? langMatch[1] : '';

  // Stars
  const starMatch = block.match(/>([\d,]+) stars?</);
  const stars = starMatch ? starMatch[1] : '';

  // Forks
  const forkMatch = block.match(/>([\d,]+) forks?</);
  const forks = forkMatch ? forkMatch[1] : '';

  // Today's stars
  const todayMatch = block.match(/>([\d,]+) stars today</);
  const today = todayMatch ? todayMatch[1] : '';

  console.log(`${i}. github.com/${repo}`);
  if (desc) console.log(`   ${desc}`);
  const meta = [];
  if (lang) meta.push(lang);
  if (stars) meta.push(`☆ ${stars}`);
  if (forks) meta.push(`${forks}`);
  if (today) meta.push(`+${today} stars today`);
  if (meta.length) console.log(`   ${meta.join(' | ')}`);
  console.log();
  i++;
}
