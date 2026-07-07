import { safeStorage } from "electron";
import { coreLog } from "@main/utils/logger";

const PREFIX = "safe:v1:";

export const isSecureText = (value: string): boolean => value.startsWith(PREFIX);

export const encryptSecureText = (plain: string): string => {
  if (!plain) return "";
  if (!safeStorage.isEncryptionAvailable()) {
    coreLog.warn("safeStorage 不可用，敏感文本将以 base64 形式落盘");
    return `${PREFIX}${Buffer.from(plain, "utf-8").toString("base64")}`;
  }
  return `${PREFIX}${safeStorage.encryptString(plain).toString("base64")}`;
};

export const decryptSecureText = (value: string): string => {
  if (!value) return "";
  if (!isSecureText(value)) return value;

  const encoded = value.slice(PREFIX.length);
  try {
    const buf = Buffer.from(encoded, "base64");
    if (!safeStorage.isEncryptionAvailable()) {
      return buf.toString("utf-8");
    }
    return safeStorage.decryptString(buf);
  } catch {
    return "";
  }
};
