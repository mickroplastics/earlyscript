/**
 * The installed app always owns `~/.earlyscript`. Launched from a T3 Code terminal it inherits
 * `T3CODE_HOME=~/.t3`, which would point its logs and server at T3 Code's live data.
 * Development keeps the variable: the dev runner sets it to the worktree's `.t3`.
 */
export function dropInheritedT3Home(env: NodeJS.ProcessEnv, isPackaged: boolean): void {
  if (isPackaged) delete env.T3CODE_HOME;
}
