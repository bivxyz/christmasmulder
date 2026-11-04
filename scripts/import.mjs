// Push an .xlsx export of Chris's sheet into the site (same code path as the cron sync).
// usage: ADMIN_TOKEN=... node scripts/import.mjs <file.xlsx> [base-url]
import { readFile } from 'node:fs/promises';

const [file, base = 'http://localhost:8787'] = process.argv.slice(2);
const res = await fetch(`${base}/api/import`, {
  method: 'POST',
  headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN}` },
  body: await readFile(file),
});
console.log(res.status, await res.text());
process.exit(res.ok ? 0 : 1);
