// @ts-check

/** @typedef {(path: string, options?: RequestInit) => Promise<any>} ApiClient */

/** @param {Blob} blob */
export async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 8192;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

/** @param {ApiClient} api @param {string} name @param {Blob} blob */
export async function uploadImageAsset(api, name, blob) {
  const content_base64 = await blobToBase64(blob);
  const result = await api("designer/assets/images", {
    method: "POST",
    body: JSON.stringify({ name, content_base64 }),
  });
  return result.path;
}
