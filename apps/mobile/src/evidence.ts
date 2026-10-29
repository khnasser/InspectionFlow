import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { uuidv7 } from '@inspectionflow/engine';
import type { AttachmentDraft } from '@inspectionflow/sync-client';

const DIR = `${FileSystem.documentDirectory}evidence/`;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12) | ((B64.indexOf(clean[i + 2]) & 63) << 6) | (B64.indexOf(clean[i + 3]) & 63);
    out[o++] = (n >> 16) & 255;
    if (clean[i + 2] !== undefined) out[o++] = (n >> 8) & 255;
    if (clean[i + 3] !== undefined) out[o++] = n & 255;
  }
  return out.subarray(0, o);
}

/**
 * Take a photo for a finding (or the inspection): compress to max 1600 px JPEG,
 * keep it in the app's private storage, hash it, and return the attachment to queue.
 * GPS comes from the inspection position the screen already holds.
 */
export async function capturePhoto(
  owner: { ownerType: 'FINDING' | 'INSPECTION'; ownerId: string },
  position?: { latitude: number; longitude: number },
): Promise<AttachmentDraft | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) throw new Error('Camera permission denied');
  const shot = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1, exif: false });
  if (shot.canceled || !shot.assets?.[0]) return null;

  const small = await ImageManipulator.manipulateAsync(shot.assets[0].uri, [{ resize: { width: 1600 } }], {
    compress: 0.7,
    format: ImageManipulator.SaveFormat.JPEG,
  });
  await FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => undefined);
  const id = uuidv7();
  const localUri = `${DIR}${id}.jpg`;
  await FileSystem.moveAsync({ from: small.uri, to: localUri });

  const b64 = await FileSystem.readAsStringAsync(localUri, { encoding: FileSystem.EncodingType.Base64 });
  const bytes = base64ToBytes(b64);
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
  const sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');

  return {
    id,
    ...owner,
    localUri,
    mimeType: 'image/jpeg',
    fileName: `${id}.jpg`,
    sizeBytes: bytes.length,
    sha256,
    capturedAt: new Date().toISOString(),
    latitude: position?.latitude,
    longitude: position?.longitude,
  };
}

/** Remove the device copy once the server confirmed the upload. */
export async function deleteLocal(uris: string[]) {
  await Promise.all(uris.map((u) => FileSystem.deleteAsync(u, { idempotent: true })));
}

/** PUT the file straight to object storage with the headers the signed URL requires. */
export async function putFile(target: { url: string; headers: Record<string, string> }, localUri: string): Promise<number> {
  const r = await FileSystem.uploadAsync(target.url, localUri, {
    httpMethod: 'PUT',
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: target.headers,
  });
  return r.status;
}
