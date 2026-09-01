import type { CommandError } from "./schemas";

export const ERROR_COPY = {
  CREDENTIALS_MISSING: "请先在设置中填写当前翻译服务的凭据。",
  AUTH_INVALID: "凭据无效，请在设置中重新填写。",
  SELECTION_EMPTY: "请先选择需要翻译的英文。",
  SELECTION_TOO_LARGE: "选区超过 12000 个字符，请缩小选区。",
  RATE_LIMITED: "请求过于频繁，请稍后重试。",
  NETWORK_UNAVAILABLE: "网络不可用，请检查连接后重试。",
  REQUEST_TIMEOUT: "翻译请求超时，请手动重试。",
  REQUEST_CANCELLED: "翻译已取消。",
  PROVIDER_UNAVAILABLE: "翻译服务暂时不可用，请稍后重试或切换服务。",
  MALFORMED_RESPONSE: "翻译服务返回了无效格式，请重试或切换服务。",
  CACHE_UNAVAILABLE: "本地缓存暂时不可用，本次翻译结果仍可正常使用。",
  INVALID_IPC_RESPONSE: "应用内部数据校验失败，请重试。",
} as const satisfies Record<CommandError["code"], string>;

export function invalidIpcResponse(): CommandError {
  return { code: "INVALID_IPC_RESPONSE", retryable: false };
}
