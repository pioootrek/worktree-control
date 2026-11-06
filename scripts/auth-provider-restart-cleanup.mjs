/** Register before signalling, including for children that fail to spawn. */
export function trackFixtureChild(children, child) {
  const closed = new Promise(resolve => {
    child.once("close", (code, signal) => { children.delete(child); resolve({ code, signal }); });
  });
  children.set(child, closed);
  return closed;
}

/** A signal request is not exit confirmation. Retain state on an unconfirmed close. */
export async function cleanupRestartFixture(children, removeState, timeoutMs = 30_000) {
  const remaining = [...children];
  const signalErrors = [];
  for (const [child] of remaining) {
    try { child.kill("SIGKILL"); } catch (error) { signalErrors.push(error); }
  }
  let timer;
  try {
    await Promise.race([
      Promise.all(remaining.map(([, closed]) => closed)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Fixture child closure unconfirmed; temporary installation retained.")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  await removeState();
  if (signalErrors.length) throw new AggregateError(signalErrors, "Fixture signal request failed.");
}
