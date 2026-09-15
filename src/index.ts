/**
 * pi-multi-quota 扩展入口。
 *
 * T1 阶段为占位实现：只保证包能被 pi 加载，
 * 不注册任何命令或 footer（由 T5 / T9 / T11-T13 补齐）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (_pi: ExtensionAPI): void {
  // T5 起在此接线 session_start / model_select / setStatus
}
