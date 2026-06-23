import { Link } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Server,
  Settings as SettingsIcon,
} from "lucide-react";
import ThemeToggle from "@/components/theme-toggle";
import { cn } from "@/utils/tailwind";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/systems", label: "Dev Systems", icon: Server },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
] as const;

function BfdMark() {
  return (
    <div className="flex size-8 items-center justify-center rounded-lg bg-red-600 text-white shadow-sm">
      <svg
        aria-hidden="true"
        fill="none"
        height="17"
        viewBox="0 0 24 24"
        width="17"
      >
        <title>Bergfreunde Deploy</title>
        <path d="M3 19h18L14.5 7.5 11 13l-2.2-3L3 19Z" fill="currentColor" />
      </svg>
    </div>
  );
}

export default function AppHeader() {
  return (
    <header className="draglayer flex h-14 shrink-0 items-center justify-between border-border border-b bg-background/95 pr-4 pl-24 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="flex min-w-0 items-center gap-3">
        <BfdMark />
        <div className="flex min-w-0 flex-col leading-none">
          <span className="font-semibold text-sm tracking-tight">
            Bergfreunde Deploy
          </span>
          <span className="text-[0.625rem] text-muted-foreground">
            deployment dashboard
          </span>
        </div>
      </div>

      <div className="no-drag flex items-center gap-2 [-webkit-app-region:no-drag]">
        <nav
          aria-label="Primary navigation"
          className="flex items-center gap-0.5 rounded-full border border-border bg-card p-1 shadow-xs"
        >
          {NAV.map(({ to, label, icon: Icon }) => (
            <Link
              activeOptions={{ exact: to === "/" }}
              activeProps={{
                className:
                  "bg-primary text-primary-foreground shadow-xs hover:bg-primary hover:text-primary-foreground",
              }}
              aria-label={label}
              className={cn(
                "inline-flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              )}
              key={to}
              title={label}
              to={to}
            >
              <Icon className="size-4" />
              <span className="sr-only">{label}</span>
            </Link>
          ))}
        </nav>
        <div className="flex size-9 items-center justify-center rounded-full border border-border bg-card shadow-xs">
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
