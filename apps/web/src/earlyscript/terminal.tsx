// Earlyscript-only: the `terminal` flag. ChatView imports the drawers from here instead of their
// own module (one-line hook in docs/upstream-divergence.md).
import { earlyscriptFlags } from "@t3tools/shared/earlyscriptFlags";
import type { ComponentProps } from "react";

import { ChatTerminalDrawers as UpstreamChatTerminalDrawers } from "../components/chat/ChatTerminalDrawers";

export function NoTerminalDrawers(_props: ComponentProps<typeof UpstreamChatTerminalDrawers>) {
  return null;
}

/** Without `terminal` the chat never mounts a terminal drawer, so no PTY session opens from it. */
export const ChatTerminalDrawers = earlyscriptFlags.terminal
  ? UpstreamChatTerminalDrawers
  : NoTerminalDrawers;
