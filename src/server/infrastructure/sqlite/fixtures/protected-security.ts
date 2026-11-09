import { basename, dirname } from "node:path";
import { resolveAppPaths } from "../../../paths";
import { maintainSecurityFence } from "../../../bootstrap/security-maintenance";
import { openControllerStore } from "../../../controller-storage";

/** Explicit protected OS operator acts for older/restored TEST fixtures. Never a store flag. */
function paths(databasePath:string) { return {...resolveAppPaths(dirname(databasePath)),databasePath}; }
export function establishFixtureSecurity(databasePath:string):void {
  const p=paths(databasePath), status=maintainSecurityFence(p,{action:"inspect"});
  if(!status.establishmentAllowed) throw new Error(`Fixture ${basename(databasePath)} is not an unestablished installation.`);
  maintainSecurityFence(p,{action:"establish",expect:status.preflight});
}
export function resumeFixtureSecurity(databasePath:string,mode:"token"|"open"|"better-auth"="token"):void {
  const p=paths(databasePath),status=maintainSecurityFence(p,{action:"inspect"});
  maintainSecurityFence(p,{action:"resume",expect:status.preflight,mode});
}
/** The first owner preserves the configured pre-migration backup; explicit establishment follows refusal. */
export async function openProtectedUpgradeFixture(databasePath:string,options:Parameters<typeof openControllerStore>[1]) {
  try {return await openControllerStore(databasePath,options);}catch(error){
    if((error as {code?:string}).code!=="security_fence_establishment_required")throw error;
    establishFixtureSecurity(databasePath);
    return openControllerStore(databasePath,options);
  }
}
