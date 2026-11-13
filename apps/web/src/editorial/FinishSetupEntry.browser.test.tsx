import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import { RUNNING_JOB } from "./firstRun.fixture";
import { FirstReviewAutoStart } from "./FinishSetupEntry";

// The pushed model state and `runNow`, answered by hand.
const mocks = vi.hoisted(() => ({
  ready: false,
  calls: [] as Array<(result: unknown) => void>,
}));
vi.mock("./onboarding/ModelDownloadCard", async () => ({
  ...(await vi.importActual<typeof import("./onboarding/ModelDownloadCard")>(
    "./onboarding/ModelDownloadCard",
  )),
  useModelDownload: () => ({ ready: mocks.ready }),
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => () => new Promise((resolve) => mocks.calls.push(resolve)),
}));

const setup = () => {
  mocks.ready = false;
  mocks.calls = [];
};

const ENVIRONMENT_ID = EnvironmentId.make("env-1");

describe("FirstReviewAutoStart", () => {
  it("asks for the first review once, when the model turns ready", async () => {
    setup();
    await using screen = await render(<FirstReviewAutoStart environmentId={ENVIRONMENT_ID} />);
    expect(mocks.calls).toHaveLength(0);
    mocks.ready = true;
    await screen.rerender(<FirstReviewAutoStart environmentId={ENVIRONMENT_ID} />);
    await vi.waitFor(() => expect(mocks.calls).toHaveLength(1));
    // Pending, then confirmed: no second request.
    await screen.rerender(<FirstReviewAutoStart environmentId={ENVIRONMENT_ID} />);
    mocks.calls[0]!(AsyncResult.success(RUNNING_JOB));
    await screen.rerender(<FirstReviewAutoStart environmentId={ENVIRONMENT_ID} />);
    expect(mocks.calls).toHaveLength(1);
  });

  it("says a failed start and retries only when asked", async () => {
    setup();
    mocks.ready = true;
    await using screen = await render(<FirstReviewAutoStart environmentId={ENVIRONMENT_ID} />);
    await vi.waitFor(() => expect(mocks.calls).toHaveLength(1));
    mocks.calls[0]!(AsyncResult.fail({ reason: "storage" }));
    await expect.element(page.getByText(/^No se pudo empezar la primera revisión\./)).toBeVisible();
    await screen.rerender(<FirstReviewAutoStart environmentId={ENVIRONMENT_ID} />);
    expect(mocks.calls).toHaveLength(1);
    await userEvent.click(page.getByRole("button", { name: "Reintentar" }));
    expect(mocks.calls).toHaveLength(2);
    mocks.calls[1]!(AsyncResult.success(RUNNING_JOB));
    await expect
      .element(page.getByText(/^No se pudo empezar la primera revisión\./))
      .not.toBeInTheDocument();
  });
});
