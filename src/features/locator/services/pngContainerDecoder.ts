import { containerSchema, type BoschContainer } from '../schemas/containerSchemas';

const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];

export interface DecodedPng { bytes: Uint8Array; pixelWidth: number; pixelHeight: number }

export const decodeBase64Container = (container: BoschContainer, expectedMediaType: string): Uint8Array => {
  const parsed = containerSchema.parse(container);
  if (parsed.contentMediaType.toLowerCase() !== expectedMediaType.toLowerCase()) {
    throw new Error(`Unexpected Container media type "${parsed.contentMediaType}", expected "${expectedMediaType}".`);
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(parsed.content)) {
    throw new Error('Container content is not RFC 4648 base64.');
  }
  let binary: string;
  try { binary = atob(parsed.content); } catch { throw new Error('Container base64 decoding failed.'); }
  if (!binary.length) throw new Error('Container payload is empty.');
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

export const decodePngContainer = (container: BoschContainer): DecodedPng => {
  const bytes = decodeBase64Container(container, 'image/png');
  if (bytes.length < 24 || pngSignature.some((value, index) => bytes[index] !== value)) {
    throw new Error('Container does not contain a valid PNG signature.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pixelWidth = view.getUint32(16, false);
  const pixelHeight = view.getUint32(20, false);
  if (!pixelWidth || !pixelHeight) throw new Error('PNG IHDR has invalid dimensions.');
  return { bytes, pixelWidth, pixelHeight };
};
