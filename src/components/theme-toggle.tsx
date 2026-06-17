import { Moon, Sun } from "lucide-react";
import { toggleTheme } from "@/actions/theme";
import { Button } from "@/components/ui/button";

export default function ThemeToggle() {
  return (
    <Button
      aria-label="Toggle theme"
      onClick={toggleTheme}
      size="icon-sm"
      variant="ghost"
    >
      <Sun className="dark:hidden" />
      <Moon className="hidden dark:block" />
    </Button>
  );
}
