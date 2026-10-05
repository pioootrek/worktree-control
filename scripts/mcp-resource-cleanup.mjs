// Teardown for this benchmark's owned child handles, never selected PIDs.
export async function cleanupResourceFixture({ cleanupClients, controller, stopController, removeState }) {
  try {
    await cleanupClients();
  } finally {
    try {
      if (controller) await stopController(controller);
    } finally {
      if (!controller || controller.exitCode !== null || controller.signalCode !== null) await removeState();
    }
  }
}
