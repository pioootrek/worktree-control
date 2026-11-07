import { ProviderAdminError } from "../server/modules/authentication";
import type { AppPaths } from "../server/paths";
import { maintainSecurityFence, type SecurityMaintenanceCommand } from "../server/bootstrap/security-maintenance";

/** No secret arguments, no online fallback and no caller-supplied trust flag. */
export function runSecurityFenceCommand(args: readonly string[], paths: AppPaths, write: (line:string)=>void): void {
  const positional: string[] = [], flags = new Map<string,string>();
  for (let i=0;i<args.length;i++) {
    const item=args[i]!;
    if (!item.startsWith("-")) { positional.push(item); continue; }
    if (!["--expect","--mode","--data-dir","--state-dir"].includes(item) || flags.has(item)) throw new ProviderAdminError("invalid_input");
    const value=args[++i];
    if (!value || value.startsWith("--")) throw new ProviderAdminError("invalid_input");
    flags.set(item,value);
  }
  if (positional.length!==2 || positional[0]!=="fence") throw new ProviderAdminError("invalid_input");
  const action=positional[1], expect=flags.get("--expect"), mode=flags.get("--mode");
  let command: SecurityMaintenanceCommand;
  if (action==="inspect" && !expect && !mode) command={action};
  else if (action==="establish" && expect && /^[0-9a-f]{64}$/.test(expect) && !mode) command={action,expect};
  else if (action==="resume" && expect && /^[0-9a-f]{64}$/.test(expect) && (mode==="token"||mode==="open"||mode==="better-auth")) command={action,expect,mode};
  else throw new ProviderAdminError("invalid_input");
  write(JSON.stringify(maintainSecurityFence(paths,command),null,2));
}
