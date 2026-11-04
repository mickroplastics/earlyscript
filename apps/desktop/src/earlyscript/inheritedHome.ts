import { adoptEarlyscriptEnvironment } from "@t3tools/shared/earlyscriptEnv";

/**
 * The desktop app takes its settings from `EARLYSCRIPT_*`, never from what T3 Code exports to
 * its terminals and agents (`T3CODE_HOME=~/.t3`, `T3CODE_THREAD_ID`, `T3_BOOT_SERVICE_UNIT`...).
 * Runs before any layer reads the environment. Development keeps the dev runner's knobs.
 */
export function adoptInheritedEnvironment(env: NodeJS.ProcessEnv, isPackaged: boolean): void {
  adoptEarlyscriptEnvironment(env, { transitional: !isPackaged, dropElectronRunAsNode: true });
}
