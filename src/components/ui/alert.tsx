import type { ComponentProps } from "react";
import { cn } from "@/utils/tailwind";

type AlertVariant = "default" | "warning" | "danger";

const variants: Record<AlertVariant, string> = {
  default: "border-border bg-card text-card-foreground",
  warning:
    "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  danger: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
};

export function Alert({
  className,
  variant = "default",
  ...props
}: ComponentProps<"div"> & { variant?: AlertVariant }) {
  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2 text-sm",
        variants[variant],
        className
      )}
      role="alert"
      {...props}
    />
  );
}

export function AlertDescription({
  className,
  ...props
}: ComponentProps<"div">) {
  return <div className={cn("leading-relaxed", className)} {...props} />;
}
