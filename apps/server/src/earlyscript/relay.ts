import { earlyscriptFlags } from "@t3tools/shared/earlyscriptFlags";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";

export const RELAY_DISABLED_MESSAGE = "The T3 relay is turned off in Earlyscript (relay flag).";

/**
 * Without `relay` the relay URL never resolves, whatever `T3CODE_RELAY_URL` or the build says, so
 * the server cannot link to the relay: no T3 Connect link, tunnel, mobile pairing or guest links.
 */
export const relayUrlConfig = <A>(config: Config.Config<A>): Config.Config<A> =>
  earlyscriptFlags.relay
    ? config
    : Config.fail(new ConfigProvider.SourceError({ message: RELAY_DISABLED_MESSAGE }));
