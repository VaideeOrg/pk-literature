"use client";

import { useState } from "react";
import { Menu, X } from "lucide-react";
import { Button } from "@pk-literature/ui";

// Wraps whatever's passed as children (SearchBox, AccountLink) behind a
// hamburger toggle below the `md:` breakpoint — layout.tsx's header row
// had no responsive handling at all before this, cramping search + nav
// links into one unbroken line on phone-width viewports. AccountLink is
// an async Server Component; passing it as `children` from layout.tsx
// (itself a Server Component) into this Client Component is the
// standard App Router pattern for that — it doesn't need to become a
// Client Component itself just because its parent toggle does.
export function MobileNavToggle({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative md:hidden">
      <Button
        variant="ghost"
        size="icon"
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </Button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-64 rounded-md border border-border bg-background p-4 shadow-lg">
          <div className="flex flex-col gap-4">{children}</div>
        </div>
      )}
    </div>
  );
}
