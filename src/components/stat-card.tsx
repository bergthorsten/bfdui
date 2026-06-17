import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/utils/tailwind";

type Tone = "default" | "success" | "warning" | "danger" | "info";

const TONE_RING: Record<Tone, string> = {
  default: "text-muted-foreground bg-muted",
  success: "text-emerald-600 dark:text-emerald-400 bg-emerald-500/15",
  warning: "text-amber-600 dark:text-amber-400 bg-amber-500/15",
  danger: "text-red-600 dark:text-red-400 bg-red-500/15",
  info: "text-sky-600 dark:text-sky-400 bg-sky-500/15",
};

export default function StatCard({
  label,
  value,
  icon: Icon,
  tone = "default",
  hint,
}: {
  label: string;
  value: string | number;
  icon: LucideIcon;
  tone?: Tone;
  hint?: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 px-4 py-3">
        <div
          className={cn(
            "flex size-9 items-center justify-center rounded-lg",
            TONE_RING[tone]
          )}
        >
          <Icon className="size-4.5" />
        </div>
        <div className="flex flex-col leading-tight">
          <span className="font-semibold text-xl tabular-nums">{value}</span>
          <span className="text-muted-foreground text-xs">{label}</span>
          {hint && (
            <span className="text-[0.625rem] text-muted-foreground/70">
              {hint}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
