/** Composing 2D face pictures in the thread that draws them (docs/FACE-RIG.md).
 *
 * Drawables of a model with a face name their face picture by a `stykface:`
 * URL and register its recipe here; the image loader (image-resources.mjs)
 * asks for the picture by that URL and gets a bitmap painted straight from the
 * recipe, with no encoding step, then caches it like any decoded image. The
 * drawings a recipe uses are decoded once and kept (a few, bounded). */
import {composeFace, recipeImages} from './face-rig.mjs';

const RECIPES = 512, DRAWINGS = 96;
const recipes = new Map(), drawings = new Map();
let scratch = null;

/** Remember what a face URL shows (latest first; the oldest are forgotten). */
export function registerFace(url, recipe) {
  if (recipes.has(url)) recipes.delete(url);
  recipes.set(url, recipe);
  while (recipes.size > RECIPES) recipes.delete(recipes.keys().next().value);
}
export const isFaceUrl = url => typeof url === 'string' && url.startsWith('stykface:');
export const faceRecipeOf = url => recipes.get(url) ?? null;

async function drawing(src) {
  let entry = drawings.get(src);
  if (!entry) {
    entry = fetch(src).then(r => r.blob()).then(b => createImageBitmap(b));
    drawings.set(src, entry);
    entry.catch(() => drawings.delete(src));
    while (drawings.size > DRAWINGS) { const [old, value] = drawings.entries().next().value; drawings.delete(old); value.then(b => b.close?.(), () => {}); }
  } else { drawings.delete(src); drawings.set(src, entry); }
  return entry;
}
const scratchContext = (w, h) => {
  if (!scratch || scratch.canvas.width < w || scratch.canvas.height < h) scratch = new OffscreenCanvas(Math.max(w, scratch?.canvas.width ?? 0), Math.max(h, scratch?.canvas.height ?? 0)).getContext('2d');
  return scratch;
};

/** The picture for a face URL as an ImageBitmap (null when the URL is unknown here). */
export async function composeFaceBitmap(url) {
  const recipe = faceRecipeOf(url); if (!recipe) return null;
  const images = new Map();
  await Promise.all(recipeImages(recipe).map(async src => { try { images.set(src, await drawing(src)); } catch { /* drawn without it */ } }));
  const canvas = new OffscreenCanvas(recipe.width, recipe.height);
  composeFace(canvas.getContext('2d'), recipe, images, scratchContext);
  return canvas.transferToImageBitmap();
}
