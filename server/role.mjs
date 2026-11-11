/**
 * 部署角色。
 *   standalone —— 账号与渲染在同一进程（单机全功能，默认，向后兼容）
 *   central    —— 只做账号与发证，不存素材、不渲染
 *   local      —— 员工本机：渲染 + 素材，登录时向中央换取签名票据
 */
const raw = String(process.env.REMIX_ROLE || "standalone").toLowerCase();
export const ROLE = ["standalone", "central", "local"].includes(raw) ? raw : "standalone";
export const isStandalone = ROLE === "standalone";
export const isCentral = ROLE === "central";
export const isLocal = ROLE === "local";

export const CENTRAL_URL = String(process.env.REMIX_CENTRAL || "").replace(/\/+$/, "");

/** local 角色必须有中央地址 */
export function assertRoleConfig(){
  if (isLocal && !CENTRAL_URL)
    throw new Error("local 角色需要设置 REMIX_CENTRAL，例如 REMIX_CENTRAL=https://remix.company.com");
}
