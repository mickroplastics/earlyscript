import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Scheduler from "../scheduling/Scheduler.ts";
import { EditorialJobsService } from "./EditorialJobsService.ts";

const EDITORIAL_DAILY_SOURCE = "editorial.daily";

/**
 * Registers the nightly run with T3's Scheduler: every tick creates the day's job when it is
 * due and runs one due job. The Scheduler's permit keeps ticks from overlapping; the job's
 * lease in `editorial_jobs` is what survives a restart. No cron, no prompt, no agent.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Scheduler;
    const jobs = yield* EditorialJobsService;
    yield* scheduler.register(EDITORIAL_DAILY_SOURCE, jobs.runDue);
  }),
);
