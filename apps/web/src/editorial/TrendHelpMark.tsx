import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";

/**
 * A dotted word that explains itself: the hint shows on hover and on keyboard focus, and
 * screen readers get it with the word, so it never depends on the pointer.
 */
export function HelpMark({ label, hint }: { readonly label: string; readonly hint: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="cursor-help rounded-xs underline decoration-dotted underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          />
        }
      >
        {label}
        <span className="sr-only">: {hint}</span>
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-64">
        {hint}
      </TooltipPopup>
    </Tooltip>
  );
}
