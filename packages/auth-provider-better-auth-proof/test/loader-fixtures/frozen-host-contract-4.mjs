// The predicate `compatibleModule` applied at a685625, frozen with its constants. This
// is that host's rule, not that host running: the proof runs no second source tree.
export const previousHostAccepts = provider => provider.contractVersion === 4
  && provider.providerId === "better-auth"
  && typeof provider.implementationVersion === "string" && /^[0-9A-Za-z.+-]{1,64}$/.test(provider.implementationVersion)
  && provider.storageRevision === 2
  && typeof provider.create === "function";
