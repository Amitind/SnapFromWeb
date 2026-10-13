import type { APIRoute } from 'astro';
import fs from 'fs-extra';
import path from 'node:path';

// Screenshots are written at runtime to public/i, but the built server only
// serves files that existed in public/ at build time (dist/client), so serve them here
const baseDir = path.join(process.cwd(), 'public', 'i');

export const GET: APIRoute = async ({ params }) => {
  const filePath = path.resolve(baseDir, `${params.path ?? ''}.png`);
  if (!filePath.startsWith(baseDir + path.sep) || !(await fs.pathExists(filePath))) {
    return new Response('Not found', { status: 404 });
  }
  return new Response(await fs.readFile(filePath), {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' },
  });
};
