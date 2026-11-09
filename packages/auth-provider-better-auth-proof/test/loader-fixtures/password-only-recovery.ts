import { authenticationProvider as actual } from "../../src/index";
/** An actual provider with the pre-P3a readiness shape. Its password path must never receive reset. */
export const authenticationProvider = {
  ...actual,
  async create(...args: Parameters<typeof actual.create>) {
    const instance = await actual.create(...args);
    return new Proxy(instance, { get(target, key) {
      if (key === "initialize") return async () => { const ready = { ...await target.initialize() }; delete ready.localFactorReset; return ready; };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  },
};
