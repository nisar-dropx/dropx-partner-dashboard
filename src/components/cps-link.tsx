"use client";
import NextLink from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

// Same query-only navigation safeguard as PendingLink, without its eager
// prefetching of every report/associate view on a slow connection.
export function CpsLink({
  href,
  children,
  className,
  prefetch,
}: {
  href: string;
  children: ReactNode;
  className?: string;
  prefetch?: false;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, setPending] = useState(false);
  useEffect(() => setPending(false), [pathname, params]);
  return (
    <NextLink
      href={href}
      className={className}
      prefetch={prefetch ?? false}
      aria-busy={pending}
      onClick={(event) => {
        if (
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          event.button !== 0
        )
          return;
        event.preventDefault();
        setPending(true);
        router.push(href);
        router.refresh();
      }}
    >
      {children}
    </NextLink>
  );
}
