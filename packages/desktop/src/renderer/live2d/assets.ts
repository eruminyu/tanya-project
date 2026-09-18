/** Local application assets only; a model manifest cannot add a network destination. */
export function localAssetUrl(path: string, base = window.location.href): string {
  const application = new URL(window.location.href);
  const url = new URL(path, base);
  if (url.protocol !== application.protocol || url.host !== application.host || url.username || url.password) {
    throw new Error('캐릭터 자산 주소를 확인하지 못했어요.');
  }
  return url.href;
}

export async function assetBuffer(path: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(localAssetUrl(path), { signal });
  if (!response.ok) throw new Error('캐릭터 파일을 불러오지 못했어요.');
  return response.arrayBuffer();
}

export async function assetText(path: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(localAssetUrl(path), { signal });
  if (!response.ok) throw new Error('캐릭터 셰이더를 불러오지 못했어요.');
  const text = await response.text();
  if (!text.trim()) throw new Error('캐릭터 셰이더가 비어 있어요.');
  return text;
}

export async function assetImage(path: string, signal: AbortSignal): Promise<ImageBitmap> {
  const response = await fetch(localAssetUrl(path), { signal });
  if (!response.ok) throw new Error('캐릭터 이미지를 불러오지 못했어요.');
  const image = await createImageBitmap(await response.blob(), { premultiplyAlpha: 'premultiply' });
  if (signal.aborted) {
    image.close();
    signal.throwIfAborted();
  }
  return image;
}
