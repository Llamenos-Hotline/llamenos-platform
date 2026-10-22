import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { OgImage } from '../../../components/OgImage';

export const GET: APIRoute = async ({ params }) => {
  const { slug } = params;
  if (!slug) {
    return new Response('Not found', { status: 404 });
  }

  const posts = await getCollection('blog');
  const post = posts.find(p => p.id === slug);
  if (!post || post.data.draft) {
    return new Response('Not found', { status: 404 });
  }

  const { title, tags } = post.data;
  const tag = tags[0];

  // Read from the repo (build cwd is site/), not fetched: the build must not depend on (or phone home to) a font CDN.
  const [regular, bold] = await Promise.all(
    ['400', '700'].map(w => readFile(resolve(process.cwd(), `src/assets/og-fonts/dm-sans-latin-${w}-normal.woff`))),
  );

  const svg = await satori(OgImage({ title, tag }), {
    width: 1200,
    height: 630,
    fonts: [
      {
        name: 'DM Sans',
        data: regular,
        weight: 400,
        style: 'normal',
      },
      {
        name: 'DM Sans',
        data: bold,
        weight: 700,
        style: 'normal',
      },
    ],
  });

  const resvg = new Resvg(svg, {
    fitTo: {
      mode: 'width',
      value: 1200,
    },
  });

  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();

  return new Response(pngBuffer, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};

export async function getStaticPaths() {
  const posts = await getCollection('blog');
  return posts
    .filter(post => !post.data.draft)
    .map(post => ({
      params: { slug: post.id },
    }));
}
