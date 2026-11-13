// Browser-only helpers, imported as '@pos/shared/browser' so the server never type-checks DOM code.
import { ITEM_IMAGE_EDGE, ITEM_IMAGE_MAX_BYTES } from './settings.ts';

/** Shrinks a picture before upload, so the server needs no image library and a menu of hundreds of items stays
 *  small: centre-cropped square, longest edge ITEM_IMAGE_EDGE px, WebP, under ITEM_IMAGE_MAX_BYTES.
 *  Used by the admin catalog and the manager's menu editor. */
export async function shrinkImage(file: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) throw new Error('That file is not a picture this browser can read.');
  // Centre-crop to a square, then shrink: every picture is the same shape, so tiles line up whatever the photo was.
  const side = Math.min(bmp.width, bmp.height);
  const edge = Math.max(1, Math.min(ITEM_IMAGE_EDGE, side));
  const canvas = document.createElement('canvas');
  canvas.width = edge;
  canvas.height = edge;
  canvas.getContext('2d')!.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, edge, edge);
  bmp.close();
  for (const q of [0.82, 0.7, 0.55, 0.4]) {
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/webp', q));
    if (blob && blob.type === 'image/webp' && blob.size <= ITEM_IMAGE_MAX_BYTES) return blob;
  }
  throw new Error(`That picture is too detailed to shrink under ${ITEM_IMAGE_MAX_BYTES / 1024} KB. Try a simpler one.`);
}
