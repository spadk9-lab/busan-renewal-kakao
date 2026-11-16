import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const normalize = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const hash = value => createHash('sha256').update(value).digest('hex');

export function canonicalUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('HTTPS official source URL required');
  if (!(url.hostname === 'busan.go.kr' || url.hostname.endsWith('.busan.go.kr') || url.hostname.endsWith('.go.kr'))) {
    throw new Error('Official government source URL required');
  }
  if (url.username || url.password) throw new Error('Credentials in URL are forbidden');
  url.hash = '';
  for (const name of [...url.searchParams.keys()]) {
    if (/^(utm_.+|fbclid|gclid)$/i.test(name)) url.searchParams.delete(name);
  }
  url.searchParams.sort();
  return url.href;
}

export function keyFor(record) {
  const issuer = normalize(record.issuer);
  const kind = normalize(record.kind);
  if (!issuer || !kind) throw new Error('issuer and kind required');
  const url = canonicalUrl(record.url);
  const number = normalize(record.number).replace(/\s/g, '');
  const identity = number ? [issuer, kind, number] : [url];
  return hash(JSON.stringify([...identity, normalize(record.revision) || 'original']));
}

export function prepare(records, state = { entries: {} }) {
  if (!Array.isArray(records)) throw new Error('Input must be an array');
  const seen = new Set();
  const queue = [];
  const skipped = [];
  for (const record of records) {
    const key = keyFor(record);
    const text = String(record.text ?? '').trim();
    // Korean text is normally BMP. Check UTF-16 as a conservative API bound.
    if (!text || text.length > 200) throw new Error('text must contain 1 to 200 characters');
    const prior = state.entries?.[key];
    if (seen.has(key) || prior?.status === 'sent' || prior?.status === 'uncertain') {
      skipped.push({ key, reason: seen.has(key) ? 'duplicate-input' : prior.status });
      continue;
    }
    seen.add(key);
    canonicalUrl(record.url);
    queue.push({
      key, issuer: normalize(record.issuer), kind: normalize(record.kind),
      number: normalize(record.number), revision: normalize(record.revision) || 'original',
      url: record.url,
      template_object: {
        object_type: 'text', text,
        link: { web_url: record.url, mobile_web_url: record.url },
        button_title: '공식 공고 보기',
      },
    });
  }
  return { preparedAt: new Date().toISOString(), queue, skipped };
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await fs.rename(tmp, file);
}

export async function main(args) {
  const [command, ...rest] = args;
  const options = {};
  if (rest.length % 2) throw new Error('Options require values');
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith('--') || options[rest[i].slice(2)] !== undefined) throw new Error('Invalid options');
    options[rest[i].slice(2)] = rest[i + 1];
  }
  const required = names => { for (const name of names) if (!options[name]) throw new Error(`Missing --${name}`); };
  required(['state']);
  // Serialize all state operations. A stale lock is never removed automatically.
  await fs.mkdir(path.dirname(path.resolve(options.state)), { recursive: true });
  const lock = `${options.state}.lock`;
  const handle = await fs.open(lock, 'wx');
  try {
    const state = await readJson(options.state, { version: 1, entries: {} });
    if (state.version !== 1 || !state.entries || Array.isArray(state.entries)) throw new Error('Invalid state');
    if (command === 'prepare') {
      required(['input', 'output']);
      const result = prepare(await readJson(options.input), state);
      await atomicJson(options.output, result);
      console.log(JSON.stringify({ prepared: result.queue.length, skipped: result.skipped.length, sent: 0 }));
    } else if (command === 'record') {
      required(['queue', 'key', 'status']);
      const item = (await readJson(options.queue)).queue.find(row => row.key === options.key);
      if (!item) throw new Error('Key absent from verified queue');
      if (!['sent', 'uncertain', 'retry'].includes(options.status)) throw new Error('Invalid status');
      if (options.status === 'sent' && options['result-code'] !== '0') throw new Error('API result_code 0 required');
      if (state.entries[item.key]?.status === 'sent' && options.status !== 'sent') throw new Error('Cannot reopen sent item');
      state.entries[item.key] = {
        status: options.status, updatedAt: new Date().toISOString(),
        issuer: item.issuer, kind: item.kind, number: item.number,
        revision: item.revision, url: item.url,
      };
      await atomicJson(options.state, state);
      console.log(JSON.stringify({ status: options.status, key: item.key }));
    } else throw new Error('Command must be prepare or record');
  } finally { await handle.close(); await fs.unlink(lock); }
}

if (import.meta.url.startsWith('file:') && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.code === 'EEXIST' ? 'State locked: another run or unresolved interrupted run exists' : error.message);
    process.exitCode = 1;
  });
}
