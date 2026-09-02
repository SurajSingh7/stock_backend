import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request store, so code deep in the model layer can know who is acting
 * without every function having to pass the actor down.
 *
 * Only ONE thing goes in here — the acting user — and only one thing reads it:
 * the actor-stamp plugin. It is deliberately not a general-purpose bag; a
 * service that needs the user should keep taking it as an argument, where the
 * dependency is visible.
 *
 * AsyncLocalStorage propagates across await points and timers, so a stamp
 * written in a Mongoose hook three awaits deep still sees the right person.
 * Outside a request — a seeder, a migration script, a cron — the store is
 * empty and the plugin leaves the fields alone, which is the honest answer:
 * nobody did it.
 */
const storage = new AsyncLocalStorage();

export const runWithActor = (actor, fn) => storage.run({ actor }, fn);

export const getActor = () => storage.getStore()?.actor ?? null;
