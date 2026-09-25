/** Isomorphic byte helpers (no Buffer / fs / DOM). */
import { MeshLoadError, type SourceFormat } from '../types.js';

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return value instanceof ArrayBuffer || Object.prototype.toString.call(value) === '[object ArrayBuffer]';
}

/** A Uint8Array view of the input's exact bytes (no copy; honours a view's byteOffset/byteLength). */
export function toBytes(data: ArrayBuffer | Uint8Array): Uint8Array {
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (isArrayBuffer(data)) return new Uint8Array(data);
  throw new MeshLoadError('Expected an ArrayBuffer or Uint8Array');
}

/**
 * An ArrayBuffer (of this realm) holding exactly the input's bytes. A view covering its
 * whole buffer is used as is; a partial view (non-zero byteOffset, shorter length) or a
 * foreign-realm / shared buffer is copied.
 */
export function toArrayBuffer(data: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    const { buffer, byteOffset, byteLength } = data;
    if (buffer instanceof ArrayBuffer && byteOffset === 0 && byteLength === buffer.byteLength) return buffer;
    const copy = new Uint8Array(byteLength);
    copy.set(new Uint8Array(buffer, byteOffset, byteLength));
    return copy.buffer;
  }
  const foreign: unknown = data;
  if (isArrayBuffer(foreign)) {
    // ArrayBuffer from another realm (iframe, vm context): copy into this realm.
    const copy = new Uint8Array(foreign.byteLength);
    copy.set(new Uint8Array(foreign));
    return copy.buffer;
  }
  throw new MeshLoadError('Expected an ArrayBuffer or Uint8Array');
}

/** UTF-8 decode (BOM stripped, invalid sequences replaced). */
export function decodeUtf8(data: ArrayBuffer | Uint8Array): string {
  return new TextDecoder('utf-8').decode(data);
}

export function readU32LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

/** Options shared by the per-format loaders. */
export interface FormatLoadContext {
  fileName?: string;
  weldEpsilon?: number;
}

/** "file.stl: " prefix for messages, or "" when no name is known. */
export function namePrefix(fileName?: string): string {
  return fileName ? `${fileName}: ` : '';
}

/** Wrap any error thrown while loading into a MeshLoadError (MeshLoadErrors pass through). */
export function toMeshLoadError(err: unknown, format: SourceFormat | undefined, fileName?: string): MeshLoadError {
  if (err instanceof MeshLoadError) return err;
  const reason = err instanceof Error ? err.message : String(err);
  const what = format ? `${format.toUpperCase()} ` : '';
  const wrapped = new MeshLoadError(`${namePrefix(fileName)}failed to parse ${what}data: ${reason}`, format);
  wrapped.cause = err;
  return wrapped;
}
