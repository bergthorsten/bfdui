import type { ReactNode } from "react";

interface PageHeaderProps {
  actions?: ReactNode;
  description?: string;
  title: string;
}

export default function PageHeader({
  title,
  description,
  actions,
}: PageHeaderProps) {
  return (
    <header className="flex shrink-0 flex-col gap-3 border-border border-b bg-background px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-6">
      <div className="flex min-w-0 flex-col gap-1 leading-tight">
        <h1 className="font-semibold text-xl leading-7 tracking-tight">
          {title}
        </h1>
        {description && (
          <p className="text-muted-foreground text-sm">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 items-center gap-2 pt-0.5">{actions}</div>
      )}
    </header>
  );
}
