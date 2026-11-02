import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EditorialProfileIssue,
  EditorialProfileVersion,
  EditorialProfileView,
  EnvironmentId,
} from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  draftFromForm,
  formFromProfile,
  issuesByField,
  profileFormChanged,
  profileFormIssues,
  profileSaveFailure,
  type ProfileFormValues,
} from "./profileForm.logic";
import { profileFieldId } from "./ProfileForm";
import { editorialProfileEnvironment } from "./profileState";

export type ProfileSaveOutcome =
  | { readonly _tag: "saved"; readonly active: EditorialProfileVersion }
  | { readonly _tag: "invalid" }
  | { readonly _tag: "failed" };

export interface ProfileEditor {
  readonly view: EditorialProfileView | null;
  readonly loadError: string | null;
  readonly retry: () => void;
  /** Null until the profile is read. */
  readonly values: ProfileFormValues | null;
  readonly setValues: (values: ProfileFormValues) => void;
  readonly edited: boolean;
  readonly errors: ReturnType<typeof issuesByField>;
  readonly saving: boolean;
  readonly failure: string | null;
  /**
   * Validates, then saves when the fields changed; an unchanged form answers the active version
   * without calling the server. An invalid form focuses its first wrong field.
   */
  readonly save: () => Promise<ProfileSaveOutcome>;
  readonly discard: () => void;
}

/** A save: the active version it produced, or the failure as the server raised it. */
export type ProfileSaveDraft = (
  draft: ReturnType<typeof draftFromForm>,
) => Promise<
  | { readonly _tag: "ok"; readonly active: EditorialProfileVersion }
  | { readonly _tag: "error"; readonly error: unknown }
  | { readonly _tag: "interrupted" }
>;

/** The form's state and rules over a read profile; `saveDraft` is the server call. */
export function useProfileForm({
  view,
  loadError,
  retry,
  saveDraft,
  formId,
}: {
  readonly view: EditorialProfileView | null;
  readonly loadError: string | null;
  readonly retry: () => void;
  readonly saveDraft: ProfileSaveDraft;
  readonly formId: string;
}): ProfileEditor {
  const [typed, setTyped] = useState<ProfileFormValues | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [serverIssues, setServerIssues] = useState<ReadonlyArray<EditorialProfileIssue>>([]);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const active = view?.active ?? null;
  const values = typed ?? (active === null ? null : formFromProfile(active));
  const issues = values === null ? [] : profileFormIssues(values);
  const errors = showErrors ? issuesByField([...issues, ...serverIssues]) : {};

  const focusFirst = (fields: ReadonlyArray<EditorialProfileIssue>) => {
    const first = fields[0];
    if (first) document.getElementById(profileFieldId(formId, first.field))?.focus();
  };

  const save = async (): Promise<ProfileSaveOutcome> => {
    if (values === null || active === null) return { _tag: "failed" };
    setFailure(null);
    setServerIssues([]);
    if (issues.length > 0) {
      setShowErrors(true);
      focusFirst(issues);
      return { _tag: "invalid" };
    }
    if (!profileFormChanged(values, active)) return { _tag: "saved", active };
    setSaving(true);
    const result = await saveDraft(draftFromForm(values));
    setSaving(false);
    if (result._tag === "ok") {
      setTyped(null);
      setShowErrors(false);
      return { _tag: "saved", active: result.active };
    }
    if (result._tag === "interrupted") return { _tag: "failed" };
    const reported = profileSaveFailure(result.error);
    if (reported.issues.length > 0) {
      setShowErrors(true);
      setServerIssues(reported.issues);
      focusFirst(reported.issues);
      return { _tag: "invalid" };
    }
    setFailure(reported.message);
    return { _tag: "failed" };
  };

  return {
    view,
    loadError,
    retry,
    values,
    setValues: (next) => {
      setTyped(next);
      setServerIssues([]);
      setFailure(null);
    },
    edited: values !== null && active !== null && profileFormChanged(values, active),
    errors,
    saving,
    failure,
    save,
    discard: () => {
      setTyped(null);
      setShowErrors(false);
      setServerIssues([]);
      setFailure(null);
    },
  };
}

/** The studio profile form over the environment's active version. */
export function useProfileEditor(environmentId: EnvironmentId, formId: string): ProfileEditor {
  const query = useEnvironmentQuery(editorialProfileEnvironment.get({ environmentId, input: {} }));
  const update = useAtomCommand(editorialProfileEnvironment.update, { reportFailure: false });
  return useProfileForm({
    view: query.data,
    loadError: query.error,
    retry: query.refresh,
    formId,
    saveDraft: async (draft) => {
      const result = await update({ environmentId, input: draft });
      if (result._tag === "Success") return { _tag: "ok", active: result.value.active };
      if (isAtomCommandInterrupted(result)) return { _tag: "interrupted" };
      return { _tag: "error", error: squashAtomCommandFailure(result) };
    },
  });
}
