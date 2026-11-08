import { createControllerAuthentication, type ControllerAuthenticationOptions } from "./authentication-provider-lifetime";

export type AuthenticationAdministrationOptions = ControllerAuthenticationOptions;
/** Stopped CLI and protected administration use the same composition as controller startup. */
export const createAuthenticationAdministration = createControllerAuthentication;

/** A pending promise/exitCode alone cannot retain Node ownership after uncertain cleanup. */
const retainedOwners = new Set<{ resource: unknown; lifetime: ReturnType<typeof setInterval> }>();
export function retainAuthenticationOwnership(resource: unknown): void {
  const retained = { resource, lifetime: setInterval(() => { void retained.resource; }, 60_000) };
  retainedOwners.add(retained); // Referenced timer, resources and actual owner locks survive normal event-loop drain.
  process.exitCode = 1;
}
