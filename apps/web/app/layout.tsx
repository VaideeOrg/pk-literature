import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { SearchBox } from "@/components/search-box";
import { CartLink } from "@/components/cart-link";
import { AccountLink } from "@/components/account-link";
import { MobileNavToggle } from "@/components/mobile-nav-toggle";

export const metadata: Metadata = {
  title: "Tamil Literature",
  description: "Discover and buy Tamil literature.",
};

// Every page renders CartLink/AccountLink in this shared layout, both of
// which forward the anonymous_id/auth cookies to apps/api-commerce and
// apps/api-identity — there is no genuinely static route in this app.
// Forcing dynamic rendering here (rather than per-page) is also what
// sidesteps a pnpm-workspace quirk: this repo installs two React majors
// side by side (apps/medusa needs 18.x, this app needs 19.x), and next's
// own build-time static-generation worker can pick up the wrong one via
// pnpm's shared phantom node_modules slot, crashing on internal App
// Router hooks. Build-time SSG isn't attempted for any route here, so
// that mismatch never gets exercised.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="border-b border-border">
          <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-4">
            <Link href="/" className="text-lg font-semibold tracking-tight">
              தமிழ் இலக்கியம்
            </Link>

            {/* md: and up — search box + account/cart inline, same as before */}
            <div className="hidden flex-1 md:block">
              <SearchBox />
            </div>
            <nav className="hidden items-center gap-4 text-sm md:flex">
              <Link href="/browse" className="text-muted-foreground hover:text-foreground">
                Browse
              </Link>
              <AccountLink />
              <CartLink />
            </nav>

            {/* below md: — cart stays visible, search + browse/account collapse behind a hamburger */}
            <div className="ml-auto flex items-center gap-2 md:hidden">
              <CartLink />
              <MobileNavToggle>
                <SearchBox />
                <Link href="/browse" className="text-sm text-muted-foreground hover:text-foreground">
                  Browse
                </Link>
                <AccountLink />
              </MobileNavToggle>
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
        <footer className="mt-16 border-t border-border py-8">
          <div className="mx-auto max-w-6xl px-4 text-sm text-muted-foreground">
            &copy; {new Date().getFullYear()} Tamil Literature Platform
          </div>
        </footer>
      </body>
    </html>
  );
}
