import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { Slot } from "radix-ui";
import { cn } from "@/utils/tailwind";

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 font-medium text-[0.6875rem] leading-none transition-colors [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-3",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border text-foreground",
        success:
          "border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
        successStrong:
          "border-transparent bg-emerald-600/20 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300",
        warning:
          "border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400",
        danger:
          "border-transparent bg-red-500/15 text-red-600 dark:text-red-400",
        info: "border-transparent bg-sky-500/15 text-sky-600 dark:text-sky-400",
        muted: "border-transparent bg-muted text-muted-foreground",
        purple:
          "border-transparent bg-violet-500/15 text-violet-600 dark:text-violet-400",
        acceptance:
          "border-transparent bg-teal-500/15 text-violet-700 dark:text-violet-300",
        testing:
          "border-transparent bg-violet-500/15 text-violet-700 dark:text-violet-300",
        testingPending:
          "border-transparent bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span";
  return (
    <Comp
      className={cn(badgeVariants({ variant }), className)}
      data-slot="badge"
      {...props}
    />
  );
}

export { Badge, badgeVariants };
