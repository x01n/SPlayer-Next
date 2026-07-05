/**
 * Base62 编码/解码工具
 * 用于一起听邀请码的压缩编码
 */

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** 将大整数编码为 base62 字符串 */
function bigIntToBase62(value: bigint): string {
  if (value === 0n) return "0";
  let result = "";
  while (value > 0n) {
    result = BASE62[Number(value % 62n)] + result;
    value = value / 62n;
  }
  return result;
}

/** 将 base62 字符串解码为大整数 */
function base62ToBigInt(encoded: string): bigint {
  let value = 0n;
  for (const c of encoded) {
    const idx = BASE62.indexOf(c);
    if (idx === -1) throw new Error("Invalid base62");
    value = value * 62n + BigInt(idx);
  }
  return value;
}

/** 将 Buffer 编码为 base62 字符串 */
function bytesToBase62(bytes: Buffer): string {
  let value = 0n;
  for (const b of bytes) {
    value = (value << 8n) | BigInt(b);
  }
  return bigIntToBase62(value);
}

/** 将 base62 字符串解码为固定长度的 Buffer */
function base62ToBytes(encoded: string, byteLength: number): Buffer {
  let value = base62ToBigInt(encoded);
  const bytes = Buffer.alloc(byteLength);
  for (let i = byteLength - 1; i >= 0; i--) {
    bytes[i] = Number(value & 0xffn);
    value = value >> 8n;
  }
  return bytes;
}

// roomId 编码：hex 字符串 -> 4 字节
function hexToBytes(hex: string): Buffer {
  return Buffer.from(hex, "hex");
}

// roomId 解码：4 字节 -> hex 字符串
function bytesToHex(bytes: Buffer): string {
  return bytes.toString("hex");
}

// roomKey 编码：base36 字符串 -> 6 字节
function base36ToBytes(str: string, byteLength: number): Buffer {
  let value = 0n;
  for (const c of str) {
    const idx = BASE36.indexOf(c);
    if (idx === -1) throw new Error("Invalid base36");
    value = value * 36n + BigInt(idx);
  }
  const bytes = Buffer.alloc(byteLength);
  for (let i = byteLength - 1; i >= 0; i--) {
    bytes[i] = Number(value & 0xffn);
    value = value >> 8n;
  }
  return bytes;
}

// roomKey 解码：6 字节 -> base36 字符串
function bytesToBase36(bytes: Buffer): string {
  let value = 0n;
  for (const b of bytes) {
    value = (value << 8n) | BigInt(b);
  }
  let result = "";
  while (value > 0n) {
    result = BASE36[Number(value % 36n)] + result;
    value = value / 36n;
  }
  return result || "0";
}

/**
 * 编码邀请码
 * roomId(8 hex chars -> 4 bytes) + roomKey(8 base36 chars -> 6 bytes) = 10 bytes
 * 10 bytes base62 encoded ≈ 14 chars
 * @param roomId - 房间ID (8字符hex)
 * @param roomKey - 房间密钥 (8字符base36)
 * @returns base62 编码的邀请码
 */
export function encodeInviteCode(roomId: string, roomKey: string): string {
  const roomIdBytes = hexToBytes(roomId);
  const roomKeyBytes = base36ToBytes(roomKey, 6);
  const combined = Buffer.concat([roomIdBytes, roomKeyBytes]);
  return bytesToBase62(combined);
}

/**
 * 解码邀请码
 * @param encoded - base62 编码的邀请码
 * @returns roomId 和 roomKey
 */
export function decodeInviteCode(encoded: string): { roomId: string; roomKey: string } {
  const bytes = base62ToBytes(encoded, 10);
  const roomIdBytes = bytes.slice(0, 4);
  const roomKeyBytes = bytes.slice(4);
  const roomId = bytesToHex(roomIdBytes);
  const roomKey = bytesToBase36(roomKeyBytes);
  return { roomId, roomKey };
}

/**
 * 检查字符串是否为有效的 base62 编码
 */
export function isValidBase62(str: string): boolean {
  for (const c of str) {
    if (BASE62.indexOf(c) === -1) return false;
  }
  return str.length > 0;
}
