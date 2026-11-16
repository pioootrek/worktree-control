import { resolve } from "node:path";
import packageJson from "../../package.json";
import { ProviderAdminError } from "../server/modules/authentication";
import type { AppPaths } from "../server/paths";
import { establishSecurityFenceWithBackup, maintainSecurityFence, type SecurityMaintenanceCommand } from "../server/bootstrap/security-maintenance";

/**
 * What the operator runs after a fence command. A trusted fence (after a
 * successful establish or resume, or a no-op on a fence already trusted) is
 * not yet an ordinary start: the database still needs `upgrade inspect`, which
 * says "current" when nothing is left to do.
 */
function nextStep(status: { trusted: boolean; establishmentAllowed: boolean }): string {
  return status.trusted ? "upgrade inspect" : status.establishmentAllowed ? "auth fence establish" : "auth fence resume";
}

/**
 * `auth fence inspect`, `auth fence establish --expect <hash> --backup-dir <dir>`
 * and `auth fence resume --expect <hash> --mode <mode>`. No secret arguments,
 * no online fallback and no caller-supplied trust flag. `--backup-dir` is
 * required by establish and refused elsewhere: one non-blank, NUL-free value,
 * made absolute. Establish takes its pre-establishment backup there
 * (`pre-establishment-v<source schema>-<UUID>`) before anything is written; a
 * trusted no-op takes none.
 */
export async function runSecurityFenceCommand(args: readonly string[], paths: AppPaths, write: (line:string)=>void, applicationVersion: string = packageJson.version): Promise<void> {
  const positional: string[] = [], flags = new Map<string,string>();
  for (let i=0;i<args.length;i++) {
    const item=args[i]!;
    if (!item.startsWith("-")) { positional.push(item); continue; }
    if (!["--expect","--mode","--backup-dir","--data-dir","--state-dir"].includes(item) || flags.has(item)) throw new ProviderAdminError("invalid_input");
    const value=args[++i];
    if (!value || value.startsWith("--")) throw new ProviderAdminError("invalid_input");
    flags.set(item,value);
  }
  if (positional.length!==2 || positional[0]!=="fence") throw new ProviderAdminError("invalid_input");
  const action=positional[1], expect=flags.get("--expect"), mode=flags.get("--mode"), directory=flags.get("--backup-dir");
  if (action==="establish") {
    if (!expect || !/^[0-9a-f]{64}$/.test(expect) || mode!==undefined || directory===undefined || !directory.trim() || directory.includes("\0")) throw new ProviderAdminError("invalid_input");
    const result=await establishSecurityFenceWithBackup(paths,{action,expect},{directory:resolve(directory),applicationVersion});
    write(JSON.stringify({...result,nextStep:nextStep(result)},null,2));
    return;
  }
  let command: SecurityMaintenanceCommand;
  if (directory!==undefined) throw new ProviderAdminError("invalid_input");
  if (action==="inspect" && !expect && !mode) command={action};
  else if (action==="resume" && expect && /^[0-9a-f]{64}$/.test(expect) && (mode==="token"||mode==="open"||mode==="better-auth")) command={action,expect,mode};
  else throw new ProviderAdminError("invalid_input");
  const result=maintainSecurityFence(paths,command);
  write(JSON.stringify({...result,nextStep:nextStep(result)},null,2));
}
