import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { toastManager } from "../../components/ui/toast";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { editorialJobsEnvironment } from "../jobsState";
import { useEditorialJobActivity } from "../TrendJobIndicator";
import { nightlyState } from "./editorialStatus.logic";
import { settingsFailureText } from "./nightlyText";

/** Now, to the minute: enough for "hoy" and "al día", and it repaints once a minute at most. */
function useNowMinuteMs(): number {
  return Date.parse(`${useNowMinute()}:00Z`);
}

/** The nightly review's settings, its latest jobs, the one in flight and where it stands. */
export function useNightlyStatus(environmentId: EnvironmentId) {
  const target = { environmentId, input: {} };
  const settings = useEnvironmentQuery(editorialJobsEnvironment.settings(target));
  const list = useEnvironmentQuery(editorialJobsEnvironment.list(target));
  const active = useEditorialJobActivity(environmentId);
  const now = useNowMinuteMs();
  return {
    settings,
    jobs: list.data?.jobs ?? null,
    active,
    now,
    state: nightlyState({
      settings: settings.data,
      jobs: list.data?.jobs ?? null,
      active,
      now,
    }),
  };
}

/** «Revisar ahora» and «Reintentar»: today's review, from the step it is missing. */
export function useRunNow(environmentId: EnvironmentId) {
  const runNow = useAtomCommand(editorialJobsEnvironment.runNow, { reportFailure: false });
  const [starting, setStarting] = useState(false);
  const run = () => {
    setStarting(true);
    void runNow({ environmentId, input: {} }).then((result) => {
      setStarting(false);
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "No se pudo revisar",
          description: settingsFailureText(result),
        });
      }
    });
  };
  return { starting, run };
}
