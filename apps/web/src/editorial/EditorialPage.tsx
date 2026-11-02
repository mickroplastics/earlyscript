import type { ReactNode } from "react";

import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { ScrollArea } from "../components/ui/scroll-area";
import { SidebarInset } from "../components/ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../components/WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../components/WorkspacePageContainer";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { workspaceAreaProps } from "../lib/workspaceFocus";

/**
 * A main-area page without a conversation: the same inset, title bar and page container as
 * the app's other non-chat pages.
 */
export function EditorialPage({
  space,
  title,
  actions,
  children,
}: {
  readonly space: string;
  readonly title?: string | undefined;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <SidebarInset
      {...workspaceAreaProps("editorial", 1, space)}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <WorkspaceBreadcrumb ariaLabel={`Ruta en ${space}`} className="flex-1">
            <WorkspaceBreadcrumbItem current={title === undefined}>
              <WorkspaceBreadcrumbText>{space}</WorkspaceBreadcrumbText>
            </WorkspaceBreadcrumbItem>
            {title === undefined ? null : (
              <>
                <WorkspaceBreadcrumbSeparator>
                  <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
                </WorkspaceBreadcrumbSeparator>
                <WorkspaceBreadcrumbItem current className="min-w-10 shrink">
                  <WorkspaceBreadcrumbText>{title}</WorkspaceBreadcrumbText>
                </WorkspaceBreadcrumbItem>
              </>
            )}
          </WorkspaceBreadcrumb>
          {actions}
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">{children}</WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

export function EditorialEmptyPage({
  space,
  title,
  description,
  children,
}: {
  readonly space: string;
  readonly title: string;
  readonly description: string;
  /** Under the description: an action that leads out of the empty state. */
  readonly children?: ReactNode;
}) {
  return (
    <SidebarInset
      {...workspaceAreaProps("editorial", 1, space)}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <span className="text-sm font-medium text-muted-foreground/60">{space}</span>
        </WorkspacePageHeader>
        <Empty className="flex-1">
          <div className="w-full max-w-lg px-8 py-12">
            <EmptyHeader className="max-w-none">
              <EmptyTitle>{title}</EmptyTitle>
              <EmptyDescription>{description}</EmptyDescription>
            </EmptyHeader>
            {children}
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
