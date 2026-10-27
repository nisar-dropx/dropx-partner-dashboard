"use client";

import NextLink from "next/link";
import { useRouter as useNextRouter } from "next/navigation";
import { createContext, useContext, type ComponentProps } from "react";

/** Optional in-memory adapter for the public demo. Live pages never install this provider. */
export type OpsScreenRuntime = {
  href: (href: string) => string;
  navigate: (href: string) => void;
  refresh: () => void;
  request: typeof fetch;
  mediaUrl: (id: string) => string;
  shiftActions: Pick<
    typeof import("@/app/ops-pulse/si-handover/actions"),
    | "startShift"
    | "saveAnswers"
    | "submitHandover"
    | "acceptHandover"
    | "rejectHandover"
    | "deleteDraftChecklist"
  >;
  storeActions: Pick<
    typeof import("@/app/ops-pulse/store-ops/actions"),
    "startDay" | "saveAnswers" | "submitDay" | "deleteDraft"
  >;
};
export const OpsScreenRuntimeContext = createContext<OpsScreenRuntime | null>(
  null,
);
export const useOpsScreenRuntime = () => useContext(OpsScreenRuntimeContext);
export function useOpsScreenRouter() {
  const live = useNextRouter();
  const demo = useOpsScreenRuntime();
  return demo
    ? {
        ...live,
        push: demo.navigate,
        replace: demo.navigate,
        refresh: demo.refresh,
      }
    : live;
}
export function useOpsScreenRequest(): typeof fetch {
  const demo = useOpsScreenRuntime();
  return demo?.request || fetch;
}
export function OpsScreenLink(props: ComponentProps<typeof NextLink>) {
  const demo = useOpsScreenRuntime();
  if (!demo) return <NextLink {...props} />;
  const target =
    typeof props.href === "string"
      ? props.href
      : String(props.href.pathname || "");
  const {
    prefetch: _prefetch,
    replace: _replace,
    scroll: _scroll,
    shallow: _shallow,
    locale: _locale,
    legacyBehavior: _legacy,
    passHref: _pass,
    ...rest
  } = props;
  return (
    <a
      {...rest}
      href={demo.href(target)}
      onClick={(event) => {
        event.preventDefault();
        demo.navigate(target);
      }}
    />
  );
}
