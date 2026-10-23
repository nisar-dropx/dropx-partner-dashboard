import type { ReactNode } from "react";

export function PageHead({
  eyebrow,
  title,
  subtitle,
  action
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {subtitle ? <p className="subtle">{subtitle}</p> : null}
      </div>
      {action ? <div className="page-head-actions">{action}</div> : null}
    </div>
  );
}
