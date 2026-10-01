// PLY header parser (contract). Reads only the ASCII header of a binary_little_endian PLY.
// Layout assumption checked by callers: size == headerBytes + stride * vertexCount.
const SIZES = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };

/**
 * @param {Uint8Array|Buffer} buf at least the whole header
 * @returns {{format: string, vertexCount: number, properties: {name: string, type: string}[], headerBytes: number, stride: number}}
 * Throws Error('ply: ...') when there is no header end, no `element vertex`, a list property, an unknown type, an empty vertex layout (stride 0), or no x/y/z property.
 */
export function parsePlyHeader(buf) {
  const marker = Buffer.from('end_header\n');
  const at = Buffer.from(buf).indexOf(marker);
  if (at < 0) throw new Error('ply: end_header not found');
  const headerBytes = at + marker.length;
  const lines = Buffer.from(buf).subarray(0, at).toString('latin1').split('\n').map((l) => l.trim());
  if (lines[0] !== 'ply') throw new Error('ply: bad magic');
  let format = null;
  let vertexCount = null;
  let inVertex = false;
  const properties = [];
  for (const l of lines.slice(1)) {
    const t = l.split(/\s+/);
    if (t[0] === 'format') format = t[1];
    else if (t[0] === 'element') {
      inVertex = t[1] === 'vertex';
      if (inVertex) vertexCount = Number(t[2]);
    } else if (t[0] === 'property' && inVertex) {
      if (t[1] === 'list') throw new Error('ply: list property unsupported');
      if (!(t[1] in SIZES)) throw new Error(`ply: unknown type ${t[1]}`);
      properties.push({ name: t[2], type: t[1] });
    }
  }
  if (format !== 'binary_little_endian') throw new Error(`ply: unsupported format ${format}`);
  if (!Number.isInteger(vertexCount) || vertexCount < 0) throw new Error('ply: element vertex missing');
  const stride = properties.reduce((s, p) => s + SIZES[p.type], 0);
  if (stride === 0) throw new Error('ply: vertex has no properties');
  for (const axis of ['x', 'y', 'z']) {
    if (!properties.some((p) => p.name === axis)) throw new Error(`ply: vertex property ${axis} missing`);
  }
  return { format, vertexCount, properties, headerBytes, stride };
}
